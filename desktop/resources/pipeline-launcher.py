"""Desktop launcher for the audio pipeline (PLAN D-307).

Serves the FastAPI app on 127.0.0.1 with uvicorn. The Electron main process starts it with
`python -I -B pipeline-launcher.py <port>` and stops it by closing the child's stdin: the
watcher thread then asks uvicorn for a graceful shutdown, and the process exits.
"""

import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "audio-pipeline", "src"))

import uvicorn  # noqa: E402
from audio_pipeline.app import app  # noqa: E402

DEFAULT_PORT = 38401
GRACEFUL_SHUTDOWN_SECONDS = 1


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_SECONDS,
    )
    server = uvicorn.Server(config)

    def watch_stdin() -> None:
        try:
            sys.stdin.buffer.read()
        finally:
            server.should_exit = True

    threading.Thread(target=watch_stdin, daemon=True).start()
    server.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
