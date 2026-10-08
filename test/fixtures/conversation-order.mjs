import { slimFixture, until } from "./slim-stream.mjs";
export async function conversationOrderFixture(t, name = "conversation-order") {
  const headings = ["Preparing availability check", "Checking the next step"];
  const text = ["Synthetic assistant reply", "Synthetic second reply"];
  const reason = (index, summary) => ({ type: "reasoning", id: `reason-${index}`, summary: [{ type: "summary_text", text: `**${summary}**\n` }] });
  const progress = (f, response, index, summary) => {
    f.send(response, { type: "response.output_item.added", output_index: index, item: { ...reason(index, summary), summary: [] } });
    f.send(response, { type: "response.reasoning_summary_part.added", item_id: `reason-${index}`, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
    f.send(response, { type: "response.reasoning_summary_text.delta", item_id: `reason-${index}`, output_index: index, summary_index: 0, delta: `**${summary}**\n` });
  };
  const f = await slimFixture(t, name, ({ response, send }) => progress({ send }, response, 0, headings[0]));
  let multipart = false;
  const read = () => f.client.request("get_visible_messages", { sessionId: f.sessionId });
  const start = async () => {
    const before = f.events.filter(e => e.type === "progress_entry").length;
    await f.client.request("submit_input", { sessionId: f.sessionId, message: "Synthetic ordering test", behavior: "auto" });
    await until(() => f.events.filter(e => e.type === "progress_entry").length > before, "actual extension publishes progress");
    return read();
  };
  const writeText = (index, value) => {
    const response = f.responses.at(-1);
    f.send(response, { type: "response.output_item.added", output_index: index, item: { ...f.item(index, ""), status: "in_progress", content: [] } });
    f.send(response, { type: "response.output_text.delta", output_index: index, content_index: 0, delta: value });
  };
  const reply = async () => {
    writeText(1, text[0]); await until(async () => (await f.visible()).some(row => row.text === text[0]), "first visible reply"); return read();
  };
  const interleave = async () => {
    multipart = true; progress(f, f.responses.at(-1), 2, headings[1]);
    await until(() => f.events.some(event => event.type === "progress_entry" && event.summary === headings[1]), "second actual progress");
    writeText(3, text[1]); await until(async () => (await f.visible()).some(row => row.text === text[1]), "second visible reply"); return read();
  };
  const finish = async () => {
    const response = f.responses.at(-1), output = [reason(0, headings[0]), f.item(1, text[0])];
    if (multipart) output.push(reason(2, headings[1]), f.item(3, text[1]));
    output.forEach((item, index) => f.send(response, { type: "response.output_item.done", output_index: index, item }));
    f.send(response, { type: "response.completed", response: { id: `response-${f.responses.length}`, status: "completed", output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }); response.end();
    await until(() => f.events.some(event => event.type === "agent_settled"), "actual actor settlement"); return read();
  };
  return { ...f, headings, text, start, reply, interleave, finish, read };
}
