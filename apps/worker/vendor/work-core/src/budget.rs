//! Host-independent Work limits. Hosts retain authority over execution and persistence.
pub const MAX_ROUNDS: usize = 32;
pub const MAX_CALLS: usize = 64;
pub const WRAP_UP_AT_CALLS: usize = 52;
pub const WRAP_UP: &str = "\nExecution budget reached. Make no further tool calls. Give a final progress report: confirmed results and their references, verification, unfinished work, and the next step. Everything completed is saved; the user can reply 'continue'. Do not describe unfinished work as completed.";

pub fn must_wrap_up(rounds: usize, calls: usize) -> bool {
    rounds >= MAX_ROUNDS - 1 || calls >= WRAP_UP_AT_CALLS
}

pub fn notice(rounds: usize, calls: usize) -> &'static str {
    if must_wrap_up(rounds, calls) {
        WRAP_UP
    } else if rounds >= MAX_ROUNDS - 5 || calls >= WRAP_UP_AT_CALLS - 8 {
        "\nFew execution steps remain. Finish essential work and verification first. Stop at a clean boundary and report remaining work if needed."
    } else {
        ""
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_a_final_response_before_either_hard_limit() {
        assert!(!must_wrap_up(0, 0));
        assert!(!must_wrap_up(MAX_ROUNDS - 2, WRAP_UP_AT_CALLS - 1));
        assert!(must_wrap_up(MAX_ROUNDS - 1, 0));
        assert!(must_wrap_up(0, WRAP_UP_AT_CALLS));
        assert!(must_wrap_up(usize::MAX, usize::MAX));
        assert_eq!(notice(0, 0), "");
        assert!(!notice(MAX_ROUNDS - 5, 0).is_empty());
    }
}
