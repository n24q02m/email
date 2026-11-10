#!/usr/bin/env python3
"""PreToolUse hook: hint when better-email-mcp credentials are not configured.

Non-blocking hint only. The server handles the unconfigured state itself: its
tools return instructions to set EMAIL_CREDENTIALS (or EMAIL_USER +
EMAIL_APP_PASSWORD) or to run `email auth outlook <address>`. There is no relay
or browser setup form.
"""

import json
import os
import sys

# Add plugins root to sys.path for shared utilities
# Add plugins root to sys.path for shared utilities if in marketplace
sys.path.append(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
try:
    from mcp_common import read_mcp_hook_input
except ImportError:
    def read_mcp_hook_input() -> dict:
        data = None
        try:
            data = json.loads(sys.stdin.read(64 * 1024))
        except Exception:
            pass
        if not isinstance(data, dict):
            print(
                json.dumps(
                    {
                        "decision": "block",
                        "reason": "Invalid input: payload must be a JSON dictionary",
                    }
                )
            )
            sys.exit(2)
        return data

SERVER_NAME = "better-email-mcp"
CREDENTIAL_KEYS = ["EMAIL_CREDENTIALS"]
EXEMPT_SUFFIXES = ("__setup", "__help", "__config")


def _is_configured() -> bool:
    for k in CREDENTIAL_KEYS:
        if os.environ.get(k):
            return True
    if os.environ.get("EMAIL_USER") and os.environ.get("EMAIL_APP_PASSWORD"):
        return True
    home = os.path.expanduser("~")
    for p in (
        home + "/.email/tokens.json",
        # Layout from before the data-directory rename. The server copies it into
        # ~/.email/ on startup, so a not-yet-restarted install is still configured.
        home + "/.better-email-mcp/tokens.json",
        home + "/.config/mcp/config.enc",
        os.path.join(home, ".config", "mcp", "config.enc"),
    ):
        if os.path.exists(p):
            return True
    return False
def main() -> None:
    data = read_mcp_hook_input()

    tool_name = data.get("tool_name")
    if not isinstance(tool_name, str):
        tool_name = ""
    if tool_name.endswith(EXEMPT_SUFFIXES):
        sys.exit(0)

    if _is_configured():
        sys.exit(0)

    # Non-blocking hint: let server handle unconfigured state
    # (its tools return setup instructions; no relay or setup form exists)
    print(
        json.dumps(
            {
                "message": (
                    "better-email-mcp: credentials not yet configured. "
                    "The server will provide setup instructions."
                ),
            }
        )
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
