use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;

/// Unix milliseconds as `2026-10-16T18:42:12.044Z`, the form every API response uses.
pub fn iso(ms: i64) -> String {
    let fmt =
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()
        .and_then(|t| t.format(fmt).ok())
        .unwrap_or_default()
}

/// Parses an RFC 3339 timestamp into Unix milliseconds.
pub fn parse_iso(value: &str) -> Option<i64> {
    let t = OffsetDateTime::parse(value, &Rfc3339).ok()?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `YYYY-MM-DD` of an instant at the given offset.
pub fn local_date(ms: i64, offset: time::UtcOffset) -> String {
    let t = OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        .to_offset(offset);
    format!("{:04}-{:02}-{:02}", t.year(), t.month() as u8, t.day())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        assert_eq!(super::iso(1792176132044), "2026-10-16T18:42:12.044Z");
        assert_eq!(super::iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            super::parse_iso("2026-10-16T18:42:12.044Z"),
            Some(1792176132044)
        );
        assert_eq!(
            super::parse_iso("2026-10-16T20:42:12.044+02:00"),
            Some(1792176132044)
        );
        assert_eq!(super::parse_iso("yesterday"), None);
    }

    #[test]
    fn date_follows_the_offset_of_that_instant() {
        let west = time::UtcOffset::from_hms(-7, 0, 0).unwrap();
        let east = time::UtcOffset::from_hms(8, 0, 0).unwrap();
        // 1970-01-01T05:00:00Z is still 1969-12-31 in UTC-7 and already 13:00 in UTC+8.
        assert_eq!(local_date(18_000_000, west), "1969-12-31");
        assert_eq!(local_date(18_000_000, east), "1970-01-01");
        assert_eq!(local_date(0, time::UtcOffset::UTC), "1970-01-01");
    }
}
