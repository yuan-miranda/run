---
description: Ensure CONTEXT.md is read and updated whenever code changes are made
globs: ["*"]
---

# Context Maintenance Rule

1. Whenever starting work on this repository, consult `CONTEXT.md` to understand system architecture, data flows, and contracts.
2. Whenever introducing or modifying endpoints, Socket.IO events, database schemas, client subsystems, installer tasks, build scripts, or frontend architecture:
   - Always update `CONTEXT.md` to match the changes.
   - Run `python scripts/verify_context.py` to confirm contracts remain synchronized.
