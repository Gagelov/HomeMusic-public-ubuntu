#!/usr/bin/env python3
"""Move a HomeMusic 1.x Hub database into the 2.0 schema.

The Hub is stopped for this: the script writes a *new* SQLite file and never
touches the old one. The music library itself is Navidrome's; this keeps the
Hub's users, sessions, history, downloads, mixes, waves, imports and files.

Usage (inside the hub image, from /app):

    python scripts/migrate-hub-1x-to-2x.py /data/hub-1x.sqlite3 /data/hub.sqlite3
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from app.db import run_migrations

NOW = datetime.now(UTC).replace(tzinfo=None).isoformat(sep=" ")


def table_info(conn: sqlite3.Connection, schema: str, table: str) -> list[tuple]:
    return conn.execute(f'PRAGMA {schema}.table_info("{table}")').fetchall()


def has_table(conn: sqlite3.Connection, schema: str, table: str) -> bool:
    return conn.execute(
        f"SELECT 1 FROM {schema}.sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def default_expr(column: tuple) -> str:
    _, name, type_, notnull, default, _ = column
    if default is not None:
        return default
    if not notnull:
        return "NULL"
    t = (type_ or "").upper()
    if "INT" in t or "BOOL" in t:
        return "0"
    if "REAL" in t or "FLOAT" in t or "DOUBLE" in t:
        return "0"
    if "DATE" in t or "TIME" in t:
        return f"'{NOW}'"
    if "JSON" in t:
        return "'[]'"
    return "''"


def copy_common(new: sqlite3.Connection, table: str, *, defaults: dict[str, str] | None = None) -> None:
    defaults = defaults or {}
    new_cols = table_info(new, "main", table)
    old_cols = {r[1] for r in table_info(new, "old", table)}
    if not new_cols or not old_cols:
        return
    names: list[str] = []
    exprs: list[str] = []
    for col in new_cols:
        name = col[1]
        if name in old_cols:
            names.append(name)
            exprs.append(f'"{name}"')
        elif name in defaults:
            names.append(name)
            exprs.append(defaults[name])
        else:
            names.append(name)
            exprs.append(default_expr(col))
    cols = ", ".join(f'"{n}"' for n in names)
    vals = ", ".join(exprs)
    new.execute(f'INSERT INTO main."{table}" ({cols}) SELECT {vals} FROM old."{table}"')


def copy_tracks(new: sqlite3.Connection) -> None:
    new.execute("""
        INSERT INTO main.tracks
            (id, album_id, artist, title, album, album_artist, track_no, disc_no, year, genre,
             duration_s, isrc, ref, explicit, fingerprint, catalog, created_at, created_by)
        SELECT id, album_id, artist, title, album, album_artist, track_no, disc_no, year, genre,
               duration_s, isrc,
               CASE
                   WHEN deezer_track_id IS NOT NULL AND deezer_track_id != '' THEN 'dz:' || deezer_track_id
                   ELSE NULL
               END,
               explicit, fingerprint,
               NULL,
               COALESCE(acquired_at, CURRENT_TIMESTAMP), added_by
        FROM old.tracks
    """)
    new.execute("""
        INSERT INTO main.track_files
            (track_id, uid, path, nd_song_id, bitrate_kbps, codec, source, source_url,
             source_upload_date, acquired_at, locked, warnings, added_by)
        SELECT id, uid, path, nd_song_id, bitrate_kbps, codec, source, source_url,
               source_upload_date, acquired_at, locked, warnings, added_by
        FROM old.tracks
        WHERE path IS NOT NULL AND path != ''
    """)


def make_songs_and_artists(new: sqlite3.Connection) -> None:
    """2.0 names a track, its file and its artists separately; old rows have one artist string."""
    rows = new.execute("SELECT id, artist, album_artist, created_at FROM main.tracks").fetchall()
    track_to_song: dict[int, int] = {}
    for track_id, _artist, _album_artist, created in rows:
        cur = new.execute("INSERT INTO main.songs (preferred_track_id, created_at) VALUES (?, ?)",
                          (track_id, created or NOW))
        song_id = cur.lastrowid
        track_to_song[track_id] = song_id
        new.execute("INSERT INTO main.song_tracks (track_id, song_id, label, joined_at) VALUES (?, ?, '', ?)",
                    (track_id, song_id, NOW))
        new.execute("UPDATE main.tracks SET ref = COALESCE(ref, 'hm:' || ?) WHERE id = ? AND ref IS NULL",
                    (track_id, track_id))
    artists: dict[str, int] = {}
    for name in sorted({r[1] for r in rows if r[1]} | {r[2] for r in rows if r[2]}):
        cur = new.execute("INSERT INTO main.artists (name, created_at) VALUES (?, ?)", (name, NOW))
        artists[name] = cur.lastrowid
    for track_id, artist, _album_artist, _created in rows:
        if artist:
            new.execute("INSERT OR IGNORE INTO main.track_artists (track_id, position, artist_id) VALUES (?, 0, ?)",
                        (track_id, artists[artist]))
    for album_id, album_artist in new.execute(
            "SELECT id, album_artist FROM main.albums WHERE album_artist IS NOT NULL AND album_artist != ''"):
        artist_id = artists.get(album_artist)
        if artist_id:
            new.execute("INSERT OR IGNORE INTO main.album_artists (album_id, position, artist_id) VALUES (?, 0, ?)",
                        (album_id, artist_id))


def copy_play_events(new: sqlite3.Connection) -> None:
    copy_common(new, "play_events", defaults={"track_id": "NULL", "page": "NULL"})
    new.execute("""
        UPDATE main.play_events AS pe SET track_id = (
            SELECT t.id FROM main.tracks AS t
            LEFT JOIN main.track_files AS tf ON tf.track_id = t.id
            WHERE (pe.nd_song_id IS NOT NULL AND tf.nd_song_id = pe.nd_song_id)
               OR (pe.ref IS NOT NULL AND t.ref = pe.ref)
            ORDER BY t.id LIMIT 1
        )
        WHERE pe.track_id IS NULL
    """)


def copy_search_history(new: sqlite3.Connection) -> None:
    if not has_table(new, "old", "search_history"):
        return
    new.execute("""
        INSERT INTO main.search_history (user_id, key, kind, title, subtitle, ref, cover_url, link, searched_at, times)
        SELECT user_id, query_key, 'query', query, NULL, NULL, NULL, NULL, searched_at, 1
        FROM old.search_history
    """)


def copy_imported_playlists(new: sqlite3.Connection) -> None:
    """The old import kept the Navidrome playlist id and song ids: make the Hub's playlists."""
    if not has_table(new, "old", "import_collections") or not has_table(new, "old", "imports"):
        return
    rows = new.execute("""
        SELECT c.id, c.title, c.position, c.cover_url, c.nd_playlist_id, c.nd_song_ids,
               i.user_id, i.created_at, i.updated_at
        FROM old.import_collections c JOIN old.imports i ON i.id = c.import_id
        WHERE c.kind = 'playlist'
    """).fetchall()
    for cid, title, _position, cover, nd_pid, nd_songs, user_id, created, updated in rows:
        cur = new.execute("""
            INSERT INTO main.playlists (user_id, kind, name, nd_playlist_id, mirrored, nd_cover, created_at, updated_at)
            VALUES (?, 'user', ?, ?, '[]', ?, ?, ?)
        """, (user_id, title or "Перенесённый плейлист", nd_pid, cover, created or NOW, updated or NOW))
        pid = cur.lastrowid
        new.execute("UPDATE main.import_collections SET playlist_id = ? WHERE id = ?", (pid, cid))
        try:
            songs = json.loads(nd_songs) if isinstance(nd_songs, str) else (nd_songs or [])
        except (TypeError, ValueError):
            songs = []
        if not isinstance(songs, list):
            continue
        for pos, song in enumerate(songs):
            tid = new.execute("""
                SELECT t.id FROM main.tracks AS t
                JOIN main.track_files AS tf ON tf.track_id = t.id
                WHERE tf.nd_song_id = ? ORDER BY t.id LIMIT 1
            """, (str(song),)).fetchone()
            if tid:
                new.execute("INSERT INTO main.playlist_items (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)",
                            (pid, tid[0], pos, created or NOW))


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    old_path, new_path = Path(sys.argv[1]), Path(sys.argv[2])
    if not old_path.is_file():
        print(f"old database not found: {old_path}", file=sys.stderr)
        return 2
    if new_path.exists():
        print(f"refusing to overwrite {new_path}; move it away first", file=sys.stderr)
        return 2
    run_migrations(new_path)
    new = sqlite3.connect(new_path)
    new.row_factory = sqlite3.Row
    new.execute("PRAGMA foreign_keys=OFF")
    new.execute("ATTACH DATABASE ? AS old", (str(old_path),))
    try:
        # Parents first. The explicit ids keep every reference in the old data valid.
        for table in ("users", "albums", "download_batches", "imports", "sessions", "ai_usage",
                      "email_codes", "invites", "source_map", "catalog_cache", "navidrome_sync",
                      "dislikes", "favorite_subjects", "assistant_chats", "assistant_tasks",
                      "smart_sessions", "smart_items", "smart_hidden", "mix_settings", "mixes",
                      "mix_items", "wave_sessions", "wave_items", "uploads", "jobs"):
            if has_table(new, "old", table) and has_table(new, "main", table):
                try:
                    copy_common(new, table, defaults={"kind": "'day'" } if table == "mixes" else None)
                except Exception as exc:
                    raise RuntimeError(f"copying {table}: {exc}") from exc
        copy_tracks(new)
        copy_common(new, "download_items", defaults={"hidden": "0", "log_json": "'[]'"})
        copy_common(new, "import_items")
        copy_common(new, "import_collections", defaults={"playlist_id": "NULL", "given": "'[]'"})
        copy_play_events(new)
        copy_search_history(new)
        copy_imported_playlists(new)
        make_songs_and_artists(new)
        new.commit()
        bad = new.execute("PRAGMA main.foreign_key_check").fetchall()
        if bad:
            print(f"foreign key check: {len(bad)} problems (kept; review {new_path})", file=sys.stderr)
        print(f"migrated {old_path} -> {new_path}")
        print("tables:", ", ".join(r[0] for r in new.execute(
            "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()))
        return 0
    finally:
        new.close()


if __name__ == "__main__":
    raise SystemExit(main())
