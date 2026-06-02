// The fallback launcher. Writes the handoff prompt to stdout. Used:
//   - when the user passes --print
//   - when no real launcher is registered for the target provider
//   - when the real launcher reports unavailable() and there's no
//     better option

function makePrintLauncher() {
  return {
    name: 'print',
    available() { return true; }, // always available
    async launch(input) {
      // The caller has already built the handoff prompt and written
      // AGENTS.md. We just emit the prompt.
      console.log(input.handoffPrompt);
      return {
        kind: 'printed',
        summary: '',
      };
    },
  };
}

module.exports = { makePrintLauncher };
