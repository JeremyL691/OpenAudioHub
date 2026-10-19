//! The desktop shell's own text: the menu-bar item, its dialogs and its errors (spec/desktop.md).
//!
//! The four catalogs are the same files the web app uses, compiled into the binary. The shell
//! picks the language saved in `config.json`, so the tray menu and the native dialogs follow the
//! choice made in the page, and a fresh install follows the system language.

use std::sync::OnceLock;

use serde_json::{Map, Value};

const EN: &str = include_str!("../locales/en.json");
const ZH_CN: &str = include_str!("../locales/zh-CN.json");
const JA: &str = include_str!("../locales/ja.json");
const KO: &str = include_str!("../locales/ko.json");

/// Holds the language chosen for this process. Set at start and on every change.
static CURRENT: OnceLock<&'static str> = OnceLock::new();

/// The language tag the page understands for a saved or system value, or `None` when it names
/// no language this build speaks.
pub fn normalize(tag: &str) -> Option<&'static str> {
    let lower = tag.to_ascii_lowercase();
    if lower == "zh" || lower.starts_with("zh-") {
        // Traditional Chinese falls back to Simplified Chinese, as the page does.
        return Some("zh-CN");
    }
    if lower == "ja" || lower.starts_with("ja-") {
        return Some("ja");
    }
    if lower == "ko" || lower.starts_with("ko-") {
        return Some("ko");
    }
    if lower == "en" || lower.starts_with("en-") {
        return Some("en");
    }
    None
}

/// The language the system would use, from the usual environment variables.
fn system_locale() -> Option<&'static str> {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(value) = std::env::var_os(name)
            && let Some(text) = value.to_str()
            && !text.is_empty()
            && let Some(locale) = normalize(text.split('.').next().unwrap_or(text))
        {
            return Some(locale);
        }
    }
    None
}

/// Settles the language for this process: the saved choice, else the system's, else English.
pub fn init(saved: Option<&str>) -> &'static str {
    let chosen = saved
        .and_then(normalize)
        .or_else(system_locale)
        .unwrap_or("en");
    CURRENT.get_or_init(|| chosen)
}

/// The language in use. `init` runs before any window exists, so this is always set.
pub fn current() -> &'static str {
    CURRENT.get().copied().unwrap_or("en")
}

/// Switches the language for this process. The next text read uses it.
pub fn set(tag: &str) -> Option<&'static str> {
    let chosen = normalize(tag)?;
    let _ = CURRENT.set(chosen);
    Some(chosen)
}

fn catalog(locale: &str) -> Map<String, Value> {
    let text = match locale {
        "zh-CN" => ZH_CN,
        "ja" => JA,
        "ko" => KO,
        _ => EN,
    };
    serde_json::from_str(text).expect("the desktop catalog is valid JSON")
}

/// The text for a dotted key such as `menu.open`, falling back to English, then to the key.
pub fn t(key: &str) -> String {
    text_in(current(), key).unwrap_or_else(|| text_in("en", key).unwrap_or_else(|| key.to_owned()))
}

/// The text for a dotted key in one language, before placeholders are filled.
fn text_in(locale: &str, key: &str) -> Option<String> {
    let mut value = Value::Object(catalog(locale));
    for part in key.split('.') {
        value = value.get(part)?.clone();
    }
    value.as_str().map(str::to_owned)
}

/// The text for a key with `{name}` placeholders filled. A missing value keeps the placeholder.
pub fn tf(key: &str, params: &[(&str, &str)]) -> String {
    let mut text = t(key);
    for (name, value) in params {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_has_the_same_keys() {
        let reference = catalog("en");
        for locale in ["en", "zh-CN", "ja", "ko"] {
            let other = catalog(locale);
            for key in reference.keys() {
                assert!(other.contains_key(key), "{locale} is missing {key}");
            }
            for key in other.keys() {
                assert!(reference.contains_key(key), "{locale} has an extra {key}");
            }
        }
    }

    #[test]
    fn every_leaf_is_a_non_empty_string_with_matching_placeholders() {
        fn leaves(map: &Map<String, Value>, prefix: &str, into: &mut Vec<(String, String)>) {
            for (key, value) in map {
                let path = format!("{prefix}.{key}");
                match value {
                    Value::String(text) => {
                        assert!(!text.trim().is_empty(), "{path} is empty");
                        into.push((path, text.clone()));
                    }
                    Value::Object(inner) => leaves(inner, &path, into),
                    other => panic!("{path} is {other:?}"),
                }
            }
        }
        fn placeholders(text: &str) -> Vec<String> {
            let mut found: Vec<String> = text
                .split('{')
                .skip(1)
                .filter_map(|rest| rest.split('}').next())
                .map(str::to_owned)
                .collect();
            found.sort();
            found
        }
        let mut reference = Vec::new();
        leaves(&catalog("en"), "", &mut reference);
        for locale in ["en", "zh-CN", "ja", "ko"] {
            let mut leaves_here = Vec::new();
            leaves(&catalog(locale), "", &mut leaves_here);
            assert_eq!(leaves_here.len(), reference.len(), "{locale} leaf count");
            for ((path, english), (_, text)) in reference.iter().zip(&leaves_here) {
                assert_eq!(placeholders(english), placeholders(text), "{locale} {path}");
            }
        }
    }

    #[test]
    fn tags_map_to_the_four_languages() {
        assert_eq!(normalize("zh-CN"), Some("zh-CN"));
        assert_eq!(normalize("zh-TW"), Some("zh-CN"));
        assert_eq!(normalize("zh"), Some("zh-CN"));
        assert_eq!(normalize("ja-JP"), Some("ja"));
        assert_eq!(normalize("ko"), Some("ko"));
        assert_eq!(normalize("en-GB"), Some("en"));
        assert_eq!(normalize("fr-FR"), None);
    }

    #[test]
    fn a_missing_key_falls_back_to_english_and_placeholders_are_filled() {
        assert!(text_in("ko", "menu.open").is_some());
        assert!(
            tf(
                "dialog.freeSpaceBody",
                &[("free", "12"), ("folder", "/tmp")]
            )
            .contains("12")
        );
        assert_eq!(t("no.such.key"), "no.such.key");
    }
}
