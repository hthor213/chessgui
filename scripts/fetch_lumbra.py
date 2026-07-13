#!/usr/bin/env python3
"""
fetch_lumbra.py — Fetch Lumbra's Gigabase (OTB master games) into the
reference-database staging area.

Lumbra's Gigabase (<https://lumbrasgigabase.com/>) is the community successor
to the now-defunct Caissabase: a large, curated corpus of over-the-board (OTB)
master games, offered in PGN. It's the CANONICAL OTB source for this pipeline
(OTB = keep everything, filter nothing).

LICENSE (verified 2026-07): CC BY-NC-SA 4.0 — "Lumbra's Gigabase © 2024-2026
by Michael Jansen is licensed under CC BY-NC-SA 4.0"
(<https://creativecommons.org/licenses/by-nc-sa/4.0/>). This permits
NON-COMMERCIAL use with ATTRIBUTION and SHARE-ALIKE: we may download it, store
it locally, and serve it from our own (non-commercial) homeserver. Bundling it
into a *commercial* product would require a separate license
(business@lumbrasgigabase.com). Provenance is stamped via the import `source`
string; attribution is carried in data/reference/README.md.

DELIVERY: the site's download buttons (WordPress Download Manager) 302-redirect
to **MEGA.nz** links, which are end-to-end encrypted — plain curl cannot fetch
them. This script resolves each `/download/<slug>/` redirect to its mega.nz URL
(decryption key in the URL fragment) and downloads it with `megadl`
(`brew install megatools`).

Packages (slugs) — OTB set (masters). Full inventory printed by --list.
    otb-complete            ~1.48 GB   (everything; the canonical pull)
    otb-2025, otb-2020-2024, otb-2015-2019, ... otb-0001-1899
    otb-elite-elo-2400      ~125 MB    (Elo > 2400 only)
    otb-partial-2026        ~51 MB     (current-year, updated monthly)

Politeness + safety: resumable (a package whose .pgn already exists is
skipped), one download at a time, identifies via User-Agent when resolving the
redirect. Downloaded archives are extracted to plain .pgn in the staging dir.

Requires: `megadl` (brew install megatools). PGN archives inside are typically
.zip/.7z — 7z needs `7z`/`7za` (brew install p7zip) if a package ships that.

Examples:
    python3 scripts/fetch_lumbra.py --list
    python3 scripts/fetch_lumbra.py --package otb-2025
    python3 scripts/fetch_lumbra.py --package otb-complete
"""

import argparse
import os
import re
import subprocess
import sys
import urllib.request

DOWNLOAD_PAGE = "https://lumbrasgigabase.com/en/download-in-pgn-format-en/"
RESOLVE_URL = "https://lumbrasgigabase.com/download/{slug}/"


def parse_args():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--package", action="append", default=[],
                   help="Package slug to fetch (repeatable), e.g. otb-2025, "
                        "otb-complete. See --list.")
    p.add_argument("--out", default="data/reference/lumbra",
                   help="Output dir (default data/reference/lumbra).")
    p.add_argument("--list", action="store_true",
                   help="List available packages (slug + label + size) and "
                        "exit.")
    p.add_argument("--keep-archive", action="store_true",
                   help="Keep the downloaded archive after extracting.")
    return p.parse_args()


def discover_packages():
    """Scrape the download page for {slug: {wpdmdl, mega_resolver_url}}.

    Returns a dict keyed by slug. The resolver URL (…/download/<slug>/?wpdmdl=)
    302-redirects to the actual mega.nz link at fetch time (the embedded
    `refresh` token expires, so we re-request the redirect fresh).
    """
    req = urllib.request.Request(
        DOWNLOAD_PAGE, headers={"User-Agent": "chessgui-refpack/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        html = r.read().decode("utf-8", "replace")
    pkgs = {}
    # data-downloadurl=".../download/<slug>/?wpdmdl=<id>&#038;refresh=<tok>"
    for m in re.finditer(
            r'/download/([a-z0-9-]+)/\?wpdmdl=(\d+)', html):
        slug, wpdmdl = m.group(1), m.group(2)
        pkgs.setdefault(slug, wpdmdl)
    return pkgs


def resolve_mega(slug, wpdmdl):
    """Follow the WPDM redirect to the mega.nz URL (no body downloaded)."""
    url = RESOLVE_URL.format(slug=slug) + f"?wpdmdl={wpdmdl}"
    req = urllib.request.Request(url, headers={"User-Agent":
                                               "chessgui-refpack/1.0"})

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        opener.open(req, timeout=30)
        return None
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            return e.headers.get("Location")
        raise


def megadl(mega_url, out_dir):
    """Download a mega.nz file with megadl into out_dir. Returns path or None."""
    if not _have("megadl"):
        sys.exit("megadl not found — install with: brew install megatools")
    before = set(os.listdir(out_dir))
    r = subprocess.run(["megadl", "--path", out_dir, mega_url])
    if r.returncode != 0:
        print(f"  megadl failed ({r.returncode})", file=sys.stderr)
        return None
    after = set(os.listdir(out_dir))
    new = [f for f in (after - before)]
    return os.path.join(out_dir, new[0]) if new else None


def extract(archive, out_dir):
    """Extract a .zip/.7z archive to out_dir; return the extracted .pgn path."""
    lower = archive.lower()
    before = set(os.listdir(out_dir))
    if lower.endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(archive) as z:
            z.extractall(out_dir)
    elif lower.endswith(".7z") or lower.endswith(".7z.001"):
        exe = "7z" if _have("7z") else ("7za" if _have("7za") else None)
        if not exe:
            sys.exit("7z not found — install with: brew install p7zip")
        subprocess.run([exe, "x", "-y", f"-o{out_dir}", archive], check=True)
    elif lower.endswith(".pgn"):
        return archive
    else:
        print(f"  unknown archive type: {archive}", file=sys.stderr)
        return None
    new_pgns = [os.path.join(out_dir, f) for f in os.listdir(out_dir)
                if f.lower().endswith(".pgn") and f not in before]
    return new_pgns[0] if new_pgns else None


def _have(exe):
    from shutil import which
    return which(exe) is not None


def main():
    args = parse_args()
    pkgs = discover_packages()

    if args.list or not args.package:
        print("Available Lumbra packages (slug):")
        for slug in sorted(pkgs):
            print(f"  {slug}")
        if not args.package:
            print("\nPass --package <slug> to fetch (e.g. otb-2025, "
                  "otb-complete).")
        return

    os.makedirs(args.out, exist_ok=True)
    for slug in args.package:
        if slug not in pkgs:
            print(f"  {slug}: unknown package (see --list)", file=sys.stderr)
            continue
        final_pgn = os.path.join(args.out, f"{slug}.pgn")
        if os.path.isfile(final_pgn) and os.path.getsize(final_pgn) > 0:
            print(f"  {slug}: already have {final_pgn} (skip)")
            continue
        print(f"  {slug}: resolving mega.nz link...")
        mega_url = resolve_mega(slug, pkgs[slug])
        if not mega_url or "mega" not in mega_url:
            print(f"  {slug}: could not resolve to a mega.nz URL "
                  f"(got {mega_url!r})", file=sys.stderr)
            continue
        print(f"  {slug}: downloading {mega_url}")
        archive = megadl(mega_url, args.out)
        if not archive:
            continue
        pgn = extract(archive, args.out)
        if pgn and pgn != final_pgn:
            os.replace(pgn, final_pgn)
            pgn = final_pgn
        if not args.keep_archive and os.path.isfile(archive) \
                and archive != final_pgn:
            os.remove(archive)
        print(f"  {slug}: -> {final_pgn}")

    print("\nDone. Lumbra is CC BY-NC-SA 4.0 (non-commercial, attribution, "
          "share-alike) — attribute in README, do not ship commercially.")


if __name__ == "__main__":
    main()
