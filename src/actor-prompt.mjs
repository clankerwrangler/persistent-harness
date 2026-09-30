/** Read Pi's rendered prompt through its public event, after all transforming
 * extensions. ResourceLoader.extensionsOverride fixes the documented load order;
 * no event getter is retained after dispatch and no private renderer is imported.
 */
export function createAgentStartPromptCapture() {
  const name = "actor-prompt-capture";
  let rendered;
  return {
    extension: { name, factory: pi => pi.on("before_agent_start", event => { rendered = event.systemPrompt; }) },
    orderLast(loaded) {
      const matches = loaded.extensions.filter(extension => extension.path === `<inline:${name}>`);
      if (matches.length !== 1) throw new Error("Expected one final agent-start prompt observer");
      return { ...loaded, extensions: [...loaded.extensions.filter(extension => extension !== matches[0]), matches[0]] };
    },
    async prepare(runner, prompt, images, options) {
      rendered = undefined;
      try {
        const prepared = await runner.emitBeforeAgentStart(prompt, images, options);
        if (typeof rendered !== "string") throw new Error("Agent-start prompt observer did not render a prompt");
        return { ...prepared, systemPrompt: rendered };
      } finally { rendered = undefined; }
    },
  };
}
