//! Spec 225: any-player profiles — the desktop shell's three native pieces.
//!
//! 1. `player_profile_run` spawns scripts/persona/build_player_profile.py
//!    (fetch → merge → stats → book → verdict-gated config) and streams every
//!    output line to the "Add player profile…" screen, exactly the
//!    measure.rs pattern (same runner, own single-run slot). On success it
//!    hands back <slug>.profile.json's text — the stored sample verdict the
//!    UI renders.
//! 2. `rival_profiles` lists every pipeline-built profile in the local
//!    rivals dir as `{ profile, stats|null }` pairs — the roster's
//!    artifact-existence gate (spec 218 precedent: absent = silently absent,
//!    never an error; data/rivals is gitignored, spec 214 hard rule).
//! 3. `save_beat_plan` writes a generated Beat-X plan to
//!    data/rivals/<slug>.BEAT.md (private — the plan names a private
//!    individual, so it lives with the rest of the gitignored artifacts).
//!
//! Dev-checkout feature like measure.rs: the script lives in the repo; a
//! bundled app gets an honest "script not found" error.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::measure::{self, MeasureLine};
use crate::persona::rivals_dir;

/// pid of the in-flight profile run (its process-group id — see measure.rs).
/// Separate from measure.rs's slot: the two pipelines don't share a work dir,
/// but each is single-run by design (both hammer the network).
static RUNNING: Mutex<Option<u32>> = Mutex::new(None);

/// Inputs to a profile pipeline run (core/player-profile-types.ts
/// ProfileRunRequest — camelCase on the wire).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRunRequest {
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub fide_id: Option<String>,
    #[serde(default)]
    pub chesscom: Option<String>,
    #[serde(default)]
    pub lichess: Option<String>,
    #[serde(default)]
    pub pgns: Vec<String>,
    #[serde(default)]
    pub unverified_event: Option<String>,
    #[serde(default)]
    pub dossier_only: Option<String>,
}

/// Final report of a run (mirrors MeasureReport, carrying the profile record
/// instead of the metrics file).
#[derive(Debug, Serialize)]
pub struct ProfileRunReport {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    /// <slug>.profile.json text after a successful run; None on failure,
    /// cancellation, or an unreadable file.
    pub profile_json: Option<String>,
}

/// Mirror of build_player_profile.py's slugify(): lowercase, Icelandic/latin
/// folds, non-alphanumeric runs → "-". Kept in lockstep so the command knows
/// which <slug>.profile.json the pipeline is about to write.
fn slugify(name: &str) -> String {
    let mut s = name.trim().to_lowercase();
    for (a, b) in [
        ("þ", "th"),
        ("ð", "d"),
        ("æ", "ae"),
        ("ö", "o"),
        ("á", "a"),
        ("é", "e"),
        ("í", "i"),
        ("ó", "o"),
        ("ú", "u"),
        ("ý", "y"),
    ] {
        s = s.replace(a, b);
    }
    let mut out = String::new();
    let mut pending_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "player".to_string()
    } else {
        out
    }
}

/// A slug that is safe as a bare file stem (matches slugify()'s output shape;
/// never a path). Guards both the profile read-back and save_beat_plan.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

/// Run the spec 225 profile pipeline for `req`, streaming output lines over
/// `on_line`. Resolves with the final report; errors are strings the UI
/// shows verbatim (script missing, already running, bad inputs).
#[tauri::command]
pub async fn player_profile_run(
    req: ProfileRunRequest,
    on_line: Channel<MeasureLine>,
) -> Result<ProfileRunReport, String> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err("Enter the player's name.".to_string());
    }
    if req.chesscom.as_deref().unwrap_or("").trim().is_empty()
        && req.lichess.as_deref().unwrap_or("").trim().is_empty()
        && req.pgns.is_empty()
    {
        return Err(
            "Add at least one game source — a chess.com or lichess username, or a PGN file."
                .to_string(),
        );
    }
    let slug = match &req.slug {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => slugify(&name),
    };
    if !valid_slug(&slug) {
        return Err(format!("Invalid profile slug: {slug:?}"));
    }

    let root = measure::repo_root();
    let script = root
        .join("scripts")
        .join("persona")
        .join("build_player_profile.py");
    if !script.exists() {
        return Err(format!(
            "build_player_profile.py not found at {} — the profile pipeline runs from the dev checkout only (it is never bundled).",
            script.display()
        ));
    }

    // Claim the single run slot (placeholder 0 until the child reports a pid).
    {
        let mut slot = RUNNING.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("A profile build is already in progress.".to_string());
        }
        *slot = Some(0);
    }

    let mut args = vec![name, "--slug".to_string(), slug.clone()];
    let mut push_opt = |flag: &str, value: &Option<String>| {
        if let Some(v) = value {
            let v = v.trim();
            if !v.is_empty() {
                args.push(flag.to_string());
                args.push(v.to_string());
            }
        }
    };
    push_opt("--fide-id", &req.fide_id);
    push_opt("--chesscom", &req.chesscom);
    push_opt("--lichess", &req.lichess);
    push_opt("--unverified-event", &req.unverified_event);
    push_opt("--dossier-only", &req.dossier_only);
    for p in &req.pgns {
        args.push("--pgn".to_string());
        args.push(p.clone());
    }

    let profile_file: PathBuf = root
        .join("data")
        .join("rivals")
        .join(format!("{slug}.profile.json"));

    let result = measure::run_pipeline(
        &measure::python_path(),
        &script,
        &args,
        &profile_file,
        &RUNNING,
        move |l| {
            let _ = on_line.send(l);
        },
    )
    .await;

    if let Ok(mut slot) = RUNNING.lock() {
        *slot = None;
    }
    result.map(|r| ProfileRunReport {
        exit_code: r.exit_code,
        cancelled: r.cancelled,
        profile_json: r.metrics_json,
    })
}

/// Cancel the in-flight profile run (SIGTERM to its process group);
/// Ok(false) when nothing is running.
#[tauri::command]
pub async fn player_profile_cancel() -> Result<bool, String> {
    measure::cancel_slot(&RUNNING)
}

/// Every *.profile.json in the local rivals dir, as `{ profile, stats|null }`
/// pairs (stats read from the sibling <stem>.stats.json). Returns `[]` when
/// the dir is absent — never an error (spec 214/218: local artifacts, absence
/// is a normal state). Unparseable files are skipped for the same reason;
/// legacy non-pipeline profile.json files (raw chess.com dumps) are passed
/// through and filtered by the frontend loader on the `sample` field.
#[tauri::command]
pub fn rival_profiles(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let Some(dir) = rivals_dir(&app) else {
        return Ok(Vec::new());
    };
    Ok(read_profiles(&dir))
}

fn read_profiles(dir: &std::path::Path) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".profile.json"))
        })
        .collect();
    paths.sort();
    let mut out = Vec::new();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(profile) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        // The stats dossier lives next to its profile as <stem>.stats.json —
        // keyed by FILENAME stem, not any field inside the JSON, so a
        // mislabeled file can never read outside the rivals dir.
        let stats = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".profile.json"))
            .and_then(|stem| {
                let text = std::fs::read_to_string(dir.join(format!("{stem}.stats.json"))).ok()?;
                serde_json::from_str::<serde_json::Value>(&text).ok()
            })
            .unwrap_or(serde_json::Value::Null);
        out.push(serde_json::json!({ "profile": profile, "stats": stats }));
    }
    out
}

/// Write a generated Beat-X training plan to <rivals dir>/<slug>.BEAT.md and
/// return the path written. The slug is validated as a bare file stem.
#[tauri::command]
pub fn save_beat_plan(
    app: tauri::AppHandle,
    slug: String,
    markdown: String,
) -> Result<String, String> {
    if !valid_slug(&slug) {
        return Err(format!("Invalid profile slug: {slug:?}"));
    }
    let dir = rivals_dir(&app).ok_or(
        "No local rivals dir found — Beat plans are written next to the profile artifacts (data/rivals in the dev checkout).",
    )?;
    let path = dir.join(format!("{slug}.BEAT.md"));
    std::fs::write(&path, markdown).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_the_python_pipeline() {
        // The arnthor precedent, straight from the spec's Origin section.
        assert_eq!(slugify("Arnþór Einarsson"), "arnthor-einarsson");
        assert_eq!(slugify("  Guðmundur  Ólafsson "), "gudmundur-olafsson");
        assert_eq!(slugify("O'Kelly, José"), "o-kelly-jose");
        assert_eq!(slugify("!!!"), "player");
        assert_eq!(slugify(""), "player");
    }

    #[test]
    fn valid_slug_rejects_path_shapes() {
        assert!(valid_slug("arnthor-einarsson"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("../etc"));
        assert!(!valid_slug("a/b"));
        assert!(!valid_slug("A-B"));
        assert!(!valid_slug("-leading"));
        assert!(!valid_slug("trailing-"));
    }

    #[test]
    fn read_profiles_pairs_stats_by_filename_stem_and_skips_garbage() {
        let dir = std::env::temp_dir().join(format!("profiles-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("alpha.profile.json"),
            r#"{"slug":"alpha","display_name":"Alpha","sample":{"verdict":"dossier-only"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("alpha.stats.json"), r#"{"slug":"alpha"}"#).unwrap();
        // No stats sibling → stats null.
        std::fs::write(
            dir.join("beta.profile.json"),
            r#"{"slug":"beta","display_name":"Beta","sample":{"verdict":"full"}}"#,
        )
        .unwrap();
        // Unparseable → skipped, not an error.
        std::fs::write(dir.join("bad.profile.json"), "{nope").unwrap();

        let rows = read_profiles(&dir);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["profile"]["slug"], "alpha");
        assert_eq!(rows[0]["stats"]["slug"], "alpha");
        assert_eq!(rows[1]["profile"]["slug"], "beta");
        assert!(rows[1]["stats"].is_null());
        std::fs::remove_dir_all(&dir).ok();
    }
}
