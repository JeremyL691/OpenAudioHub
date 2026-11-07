ALTER TABLE api_credentials ADD COLUMN transcription_model TEXT;
ALTER TABLE api_credentials ADD COLUMN enhancement_model TEXT;
ALTER TABLE api_credentials ADD COLUMN transcription_models TEXT NOT NULL DEFAULT '[]';
ALTER TABLE api_credentials ADD COLUMN enhancement_models TEXT NOT NULL DEFAULT '[]';

UPDATE api_credentials
SET transcription_model = default_model,
    transcription_models = json_array(default_model)
WHERE default_model IS NOT NULL
  AND TRIM(default_model) <> ''
  AND (
      provider = 'ElevenLabs'
      OR provider = 'Google Gemini'
      OR provider = 'OpenRouter'
      OR LOWER(default_model) LIKE '%whisper%'
      OR LOWER(default_model) LIKE '%asr%'
      OR LOWER(default_model) LIKE '%sensevoice%'
      OR LOWER(default_model) LIKE '%telespeech%'
      OR LOWER(default_model) LIKE '%transcribe%'
      OR LOWER(default_model) LIKE '%scribe%'
      OR LOWER(default_model) LIKE '%parakeet%'
      OR LOWER(default_model) LIKE '%speech%'
  );

UPDATE api_credentials
SET enhancement_model = default_model,
    enhancement_models = json_array(default_model)
WHERE default_model IS NOT NULL
  AND TRIM(default_model) <> ''
  AND provider <> 'ElevenLabs'
  AND NOT (
      LOWER(default_model) LIKE '%whisper%'
      OR LOWER(default_model) LIKE '%asr%'
      OR LOWER(default_model) LIKE '%sensevoice%'
      OR LOWER(default_model) LIKE '%telespeech%'
      OR LOWER(default_model) LIKE '%transcribe%'
      OR LOWER(default_model) LIKE '%scribe%'
      OR LOWER(default_model) LIKE '%parakeet%'
      OR LOWER(default_model) LIKE '%speech%'
  );
