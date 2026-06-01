# ATEM Provider Contract
Before working:
1. Read active session files.
2. Respect repository boundary.
3. Preserve decisions and scope.

Before stopping:
1. Update handoff.md.
2. Update state.md.
3. Update next.md.
4. Update validation.md.
5. Update decisions.md where relevant.
6. Update log.md.

## Adapter Flow Contract
Use `atem adapter ...` when a provider integration needs structured session read/write behavior.

Recommended pattern:
1. `atem adapter <provider> read <task-id>` to load current state.
2. `atem adapter <provider> update <task-id> key=value ...` for summary/status/provider metadata.
3. `atem adapter <provider> touched <task-id> <file...>` to register modified files.
4. `atem adapter <provider> validation <task-id> <command>` to record validation command intent.
5. `atem adapter <provider> log <task-id> <message>` and `decision` for final context capture.

This keeps provider-local activity synchronized into ATEM's provider-neutral session files.
