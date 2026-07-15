//! Narrow filesystem adapter over the pinned official apply-patch parser.

use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use codex_utils_path_uri::PathUri;
use thiserror::Error;

#[path = "../../../vendor/openai-codex/codex-rs/apply-patch/src/parser.rs"]
#[allow(clippy::pedantic)]
mod parser;
#[path = "../../../vendor/openai-codex/codex-rs/apply-patch/src/seek_sequence.rs"]
#[allow(clippy::pedantic)]
mod seek_sequence;
#[path = "../../../vendor/openai-codex/codex-rs/apply-patch/src/streaming_parser.rs"]
#[allow(clippy::pedantic)]
mod streaming_parser;

pub use parser::Hunk;
pub use parser::ParseError;
pub use parser::UpdateFileChunk;
pub use parser::parse_patch;

#[derive(Debug, PartialEq)]
pub struct ApplyPatchArgs {
    pub patch: String,
    pub hunks: Vec<Hunk>,
    pub workdir: Option<String>,
    pub environment_id: Option<String>,
}

#[derive(Debug, Error)]
pub enum ApplyPatchError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("{0}")]
    InvalidPath(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    ComputeReplacements(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AffectedPaths {
    pub added: Vec<PathBuf>,
    pub modified: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
}

#[must_use]
pub fn affected_paths(hunks: &[Hunk]) -> AffectedPaths {
    let mut affected = AffectedPaths {
        added: Vec::new(),
        modified: Vec::new(),
        deleted: Vec::new(),
    };
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, .. } => affected.added.push(path.clone()),
            Hunk::DeleteFile { path } => affected.deleted.push(path.clone()),
            Hunk::UpdateFile { path, .. } => affected.modified.push(path.clone()),
        }
    }
    affected
}

/// Applies a parsed Codex patch to a native working directory.
///
/// # Errors
///
/// Returns an error when the patch is invalid or a requested filesystem mutation fails.
pub fn apply_patch(patch: &str, cwd: &Path) -> Result<AffectedPaths, ApplyPatchError> {
    let parsed = parse_patch(patch)?;
    if parsed.hunks.is_empty() {
        return Err(ApplyPatchError::InvalidPath(
            "No files were modified.".to_owned(),
        ));
    }
    let cwd = PathUri::from_host_native_path(cwd).map_err(|error| {
        ApplyPatchError::InvalidPath(format!("invalid working directory: {error}"))
    })?;
    let affected = affected_paths(&parsed.hunks);
    for hunk in &parsed.hunks {
        apply_hunk(hunk, &cwd)?;
    }
    Ok(affected)
}

fn apply_hunk(hunk: &Hunk, cwd: &PathUri) -> Result<(), ApplyPatchError> {
    let path = hunk
        .resolve_path(cwd)
        .map_err(|error| ApplyPatchError::InvalidPath(format!("invalid patch path: {error}")))?;
    let path = path.to_path_buf();
    match hunk {
        Hunk::AddFile { contents, .. } => write_with_parents(&path, contents),
        Hunk::DeleteFile { .. } => {
            ensure_regular_file(&path)?;
            fs::remove_file(&path).map_err(|source| ApplyPatchError::Io {
                context: format!("Failed to delete file {}", path.display()),
                source,
            })
        }
        Hunk::UpdateFile {
            move_path, chunks, ..
        } => {
            ensure_regular_file(&path)?;
            let original = fs::read_to_string(&path).map_err(|source| ApplyPatchError::Io {
                context: format!("Failed to read file to update {}", path.display()),
                source,
            })?;
            let updated = derive_new_contents(&original, &path, chunks)?;
            if let Some(destination) = move_path {
                let destination = cwd
                    .join(&destination.to_string_lossy())
                    .map_err(|error| {
                        ApplyPatchError::InvalidPath(format!("invalid move path: {error}"))
                    })?
                    .to_path_buf();
                write_with_parents(&destination, &updated)?;
                fs::remove_file(&path).map_err(|source| ApplyPatchError::Io {
                    context: format!("Failed to remove original {}", path.display()),
                    source,
                })
            } else {
                fs::write(&path, updated).map_err(|source| ApplyPatchError::Io {
                    context: format!("Failed to write file {}", path.display()),
                    source,
                })
            }
        }
    }
}

fn ensure_regular_file(path: &Path) -> Result<(), ApplyPatchError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| ApplyPatchError::Io {
        context: format!("Failed to inspect file {}", path.display()),
        source,
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ApplyPatchError::InvalidPath(format!(
            "patch path is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn write_with_parents(path: &Path, contents: &str) -> Result<(), ApplyPatchError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| ApplyPatchError::Io {
            context: format!("Failed to create parent directories for {}", path.display()),
            source,
        })?;
    }
    fs::write(path, contents).map_err(|source| ApplyPatchError::Io {
        context: format!("Failed to write file {}", path.display()),
        source,
    })
}

fn derive_new_contents(
    original: &str,
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> Result<String, ApplyPatchError> {
    let mut original_lines = original.split('\n').map(String::from).collect::<Vec<_>>();
    if original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }
    let replacements = compute_replacements(&original_lines, &path.display().to_string(), chunks)?;
    let mut new_lines = apply_replacements(original_lines, &replacements);
    if !new_lines.last().is_some_and(String::is_empty) {
        new_lines.push(String::new());
    }
    Ok(new_lines.join("\n"))
}

fn compute_replacements(
    original_lines: &[String],
    path: &str,
    chunks: &[UpdateFileChunk],
) -> Result<Vec<(usize, usize, Vec<String>)>, ApplyPatchError> {
    let mut replacements = Vec::new();
    let mut line_index = 0;
    for chunk in chunks {
        if let Some(context) = &chunk.change_context {
            if let Some(index) = seek_sequence::seek_sequence(
                original_lines,
                std::slice::from_ref(context),
                line_index,
                false,
            ) {
                line_index = index + 1;
            } else {
                return Err(ApplyPatchError::ComputeReplacements(format!(
                    "Failed to find context '{context}' in {path}"
                )));
            }
        }
        if chunk.old_lines.is_empty() {
            replacements.push((original_lines.len(), 0, chunk.new_lines.clone()));
            continue;
        }
        let mut pattern = chunk.old_lines.as_slice();
        let mut replacement = chunk.new_lines.as_slice();
        let mut found =
            seek_sequence::seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if replacement.last().is_some_and(String::is_empty) {
                replacement = &replacement[..replacement.len() - 1];
            }
            found = seek_sequence::seek_sequence(
                original_lines,
                pattern,
                line_index,
                chunk.is_end_of_file,
            );
        }
        let Some(start) = found else {
            return Err(ApplyPatchError::ComputeReplacements(format!(
                "Failed to find expected lines in {path}:\n{}",
                chunk.old_lines.join("\n")
            )));
        };
        replacements.push((start, pattern.len(), replacement.to_vec()));
        line_index = start + pattern.len();
    }
    replacements.sort_by_key(|(index, _, _)| *index);
    Ok(replacements)
}

fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String> {
    for (start, old_len, new_lines) in replacements.iter().rev() {
        lines.splice(*start..*start + *old_len, new_lines.clone());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_add_update_move_and_delete_with_the_official_parser() {
        let root = std::env::temp_dir().join(format!("codex-apply-patch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("old.txt"), "first\nsecond\n").unwrap();
        fs::write(root.join("delete.txt"), "remove\n").unwrap();
        let patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-first\n+changed\n second\n*** Add File: added.txt\n+added\n*** Delete File: delete.txt\n*** End Patch";
        let affected = apply_patch(patch, &root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("moved.txt")).unwrap(),
            "changed\nsecond\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("added.txt")).unwrap(),
            "added\n"
        );
        assert!(!root.join("old.txt").exists());
        assert!(!root.join("delete.txt").exists());
        assert_eq!(affected.added, vec![PathBuf::from("added.txt")]);
        let _ = fs::remove_dir_all(root);
    }
}
