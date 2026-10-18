//! Administrative commands run from a shell with the server's environment.

use sqlx::SqlitePool;

use crate::db::now_ms;
use crate::{crypto, ids};

/// Gives the account a new random password and signs it out everywhere.
/// Returns the new password, which is shown once and never stored in plain text.
pub async fn reset_password(db: &SqlitePool, email: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    let user_id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    let user_id = user_id.ok_or_else(|| format!("no account with the email {email}"))?;
    let password = ids::token_hex(12);
    let hash = crypto::hash_password(&password);
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at",
    )
    .bind(&user_id)
    .bind(&hash)
    .bind(now_ms())
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(password)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reset_sets_a_working_password_and_ends_sessions() {
        let db = crate::db::open_memory().await.unwrap();
        sqlx::query("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u', 'me@example.test', 0, 0)").execute(&db).await.unwrap();
        sqlx::query("INSERT INTO sessions (id, user_id, expires_at, created_at, updated_at) VALUES ('s', 'u', 9999999999999, 0, 0)").execute(&db).await.unwrap();
        let password = reset_password(&db, " Me@Example.test ").await.unwrap();
        let hash: String =
            sqlx::query_scalar("SELECT password_hash FROM credentials WHERE user_id = 'u'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(crypto::verify_password(&hash, &password));
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
        assert!(reset_password(&db, "nobody@example.test").await.is_err());
    }
}
