-- SiliconFlow (China) and OpenCode Go are built-in presets now. Move the
-- matching 'Custom' rows onto them. Keys, models and default flags stay as
-- they are. The OpenCode Go row also drops the local proxy URL, because the
-- app sends the session header itself.
UPDATE "api_credentials"
SET "provider" = 'SiliconFlow (China)'
WHERE "provider" = 'Custom'
  AND "base_url" LIKE 'https://api.siliconflow.cn/%';--> statement-breakpoint
UPDATE "api_credentials"
SET "provider" = 'OpenCode Go',
    "base_url" = 'https://opencode.ai/zen/go/v1'
WHERE "provider" = 'Custom'
  AND "base_url" LIKE '%/zen/go/v1';
