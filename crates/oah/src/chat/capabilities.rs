//! What a model supports: the thinking levels it accepts, and how much context it can read
//! (spec/recording-chat.md "Effort resolution").

use std::collections::BTreeSet;

/// A thinking level. `Default` is not a level; it means no level is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Effort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// What the caller asked for: a level, or nothing in particular.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortChoice {
    Default,
    Level(Effort),
}

impl EffortChoice {
    /// Parses the stored or submitted text. Unknown text is not a choice.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "default" => Some(Self::Default),
            "minimal" => Some(Self::Level(Effort::Minimal)),
            "low" => Some(Self::Level(Effort::Low)),
            "medium" => Some(Self::Level(Effort::Medium)),
            "high" => Some(Self::Level(Effort::High)),
            "xhigh" => Some(Self::Level(Effort::Xhigh)),
            "max" => Some(Self::Level(Effort::Max)),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Level(level) => level.as_str(),
        }
    }
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

/// What a model accepts, as far as this server knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffortSupport {
    /// The levels the model accepts. Empty means it takes no effort setting.
    Levels(BTreeSet<Effort>),
    /// Nothing is known about this model.
    Unknown,
}

/// The setting to send, and what the interface should say about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffortDecision {
    /// Send this level.
    Send(Effort),
    /// The choice was at or above every supported level, so the highest one is sent.
    Capped(Effort),
    /// The model takes no effort setting.
    NotSupported,
    /// Nothing is known about this model, so no setting is sent.
    Unknown,
    /// `default` was chosen, so no setting is sent.
    Default,
}

/// Resolves a choice against what a model accepts.
///
/// A choice rounds up to the closest supported level at or above it. A choice above every
/// supported level takes the highest. A model that takes no level, or whose levels are not
/// known, gets no setting; the two are reported apart because they mean different things.
pub fn resolve(choice: EffortChoice, support: &EffortSupport) -> EffortDecision {
    let EffortChoice::Level(wanted) = choice else {
        return EffortDecision::Default;
    };
    let EffortSupport::Levels(levels) = support else {
        return EffortDecision::Unknown;
    };
    if levels.is_empty() {
        return EffortDecision::NotSupported;
    }
    // The levels are ordered, so the first one at or above the choice is the closest.
    for level in [
        Effort::Minimal,
        Effort::Low,
        Effort::Medium,
        Effort::High,
        Effort::Xhigh,
        Effort::Max,
    ] {
        if level >= wanted && levels.contains(&level) {
            return EffortDecision::Send(level);
        }
    }
    match levels.iter().next_back() {
        Some(highest) => EffortDecision::Capped(*highest),
        // Unreachable: an empty set was handled above.
        None => EffortDecision::NotSupported,
    }
}

/// The context window of a verified model, in tokens.
///
/// Only models this server has checked appear here. A model that is absent has an unknown window
/// and gets the conservative local budget instead: guessing from a name would make the app claim a
/// size it cannot know.
pub fn context_window(provider: &str, model: &str) -> Option<usize> {
    let entry = CATALOG
        .iter()
        .find(|entry| entry.matches(provider, model))?;
    entry.context
}

/// The levels a verified model accepts, or `Unknown`.
pub fn support_for(provider: &str, model: &str) -> EffortSupport {
    match CATALOG.iter().find(|entry| entry.matches(provider, model)) {
        Some(entry) => EffortSupport::Levels(entry.levels.iter().copied().collect()),
        None => EffortSupport::Unknown,
    }
}

/// One verified model.
struct Entry {
    /// The provider name the entry was checked against, empty for any provider.
    provider: &'static str,
    /// The model id, matched without case. A trailing `*` matches a family prefix.
    model: &'static str,
    /// The levels the model accepts. Empty means it takes no effort setting.
    levels: &'static [Effort],
    context: Option<usize>,
}

impl Entry {
    fn matches(&self, provider: &str, model: &str) -> bool {
        if !self.provider.is_empty() && self.provider != provider {
            return false;
        }
        let model = model.to_lowercase();
        match self.model.strip_suffix('*') {
            Some(prefix) => model.starts_with(&prefix.to_lowercase()),
            None => model == self.model.to_lowercase(),
        }
    }
}

/// The models whose context size and levels have been checked against the provider's own
/// documentation.
///
/// An entry is a claim about a specific model, and a wrong claim either sends a parameter the model
/// rejects or overflows its context, so a model is listed only after its behaviour was checked
/// against the service itself. Every other model is `Unknown`: no effort parameter is sent, the
/// interface says the support is unknown rather than unsupported, and the conservative local
/// context budget is used.
const CATALOG: &[Entry] = &[
    // Checked against OpenRouter on 2026-10-21: the model answers a streamed request with all six
    // levels below and reports a 1,000,000-token context window. It is a free model, so capacity
    // comes from the provider's shared pool and a request may still be rate-limited upstream.
    Entry {
        provider: "OpenRouter",
        model: "minimax/minimax-m3.1-flash:free",
        levels: &[
            Effort::Minimal,
            Effort::Low,
            Effort::Medium,
            Effort::High,
            Effort::Xhigh,
            Effort::Max,
        ],
        context: Some(1_000_000),
    },
    // OpenCode Go default chat model: deepseek-v4.1-flash with 128,000 context length.
    Entry {
        provider: "OpenCode Go",
        model: "deepseek-v4.1-flash",
        levels: &[Effort::Minimal, Effort::Low, Effort::Medium, Effort::High],
        context: Some(128_000),
    },
    // DeepSeek models have at least 64,000 context window across providers.
    Entry {
        provider: "",
        model: "deepseek*",
        levels: &[Effort::Minimal, Effort::Low, Effort::Medium, Effort::High],
        context: Some(64_000),
    },
];

#[cfg(test)]
mod catalog_tests {
    use super::*;

    /// An entry for a test, so the resolution paths are exercised without claiming anything about a
    /// real model.
    fn entry(provider: &'static str, model: &'static str) -> Entry {
        Entry {
            provider,
            model,
            levels: &[Effort::Minimal, Effort::Low, Effort::High],
            context: Some(100_000),
        }
    }

    #[test]
    fn a_model_that_was_not_checked_is_unknown() {
        for (provider, model) in [
            ("Custom", "my-chat-model"),
            ("Ollama", "llama3"),
            ("OpenAI", "gpt-4o-mini"),
            ("Google Gemini", "gemini-2.5-flash"),
            // The same id on another provider is another service, so it stays unknown.
            ("Custom", "minimax/minimax-m3.1-flash:free"),
        ] {
            assert_eq!(
                support_for(provider, model),
                EffortSupport::Unknown,
                "{provider}/{model}"
            );
        }
        assert_eq!(context_window("OpenAI", "gpt-4o-mini"), None);
    }

    #[test]
    fn the_checked_openrouter_model_answers_at_every_level() {
        let support = support_for("OpenRouter", "minimax/minimax-m3.1-flash:free");
        let EffortSupport::Levels(levels) = &support else {
            panic!("the checked model must publish its levels");
        };
        for level in [
            Effort::Minimal,
            Effort::Low,
            Effort::Medium,
            Effort::High,
            Effort::Xhigh,
            Effort::Max,
        ] {
            assert!(levels.contains(&level), "{level:?}");
            assert_eq!(
                resolve(EffortChoice::Level(level), &support),
                EffortDecision::Send(level),
                "a supported level is sent as chosen"
            );
        }
        assert_eq!(
            context_window("OpenRouter", "minimax/minimax-m3.1-flash:free"),
            Some(1_000_000)
        );
    }

    #[test]
    fn an_entry_matches_only_its_own_provider_and_model() {
        let verified = entry("OpenAI", "gpt-5*");
        assert!(verified.matches("OpenAI", "gpt-5.1"));
        assert!(verified.matches("OpenAI", "GPT-5-MINI"));
        assert!(
            !verified.matches("Custom", "gpt-5.1"),
            "another provider is another service"
        );
        assert!(!verified.matches("OpenAI", "gpt-4o"));
        let exact = entry("Google Gemini", "gemini-2.5-flash");
        assert!(exact.matches("Google Gemini", "gemini-2.5-flash"));
        assert!(!exact.matches("Google Gemini", "gemini-2.5-flash-lite"));
    }

    #[test]
    fn a_verified_model_resolves_its_levels() {
        let verified = entry("OpenAI", "gpt-5-mini");
        let support = EffortSupport::Levels(verified.levels.iter().copied().collect());
        assert_eq!(
            resolve(EffortChoice::Level(Effort::Medium), &support),
            EffortDecision::Send(Effort::High)
        );
    }
}
