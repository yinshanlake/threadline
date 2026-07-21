import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/controller.mjs";
import { createDemoConversation, rootScope } from "../src/model.mjs";
import { DemoProvider } from "../src/providers/demo.mjs";
import { buildConversationView, overviewView } from "../src/render.mjs";

test("interactive demo showcases nested threads, grouped tools, and paged output", () => {
  const conversation = createDemoConversation();
  const root = rootScope(conversation);
  const branches = conversation.scopes.filter((scope) => scope.parentId);
  const nested = branches.find((scope) => branches.some((parent) => parent.id === scope.parentId));
  const toolTurn = root.turns.find((turn) => turn.assistant.activities.length === 4);
  const longActivity = toolTurn.assistant.activities.find((activity) => activity.id === "demo-command");
  const view = buildConversationView(conversation, { width: 88 });

  assert.equal(branches.length, 3);
  assert.ok(nested);
  assert.equal(toolTurn.assistant.timeline.filter((entry) => entry.kind === "activity").length, 4);
  assert.ok(longActivity.output.length > 8_192);
  assert.ok(view.selectables.some((item) => item.kind === "activity-group" && item.activityIds.length === 4));
  assert.equal(overviewView(conversation, 88).selectables.length, 3);
});

test("demo provider supplies offline model and command catalogs", async () => {
  const provider = new DemoProvider();
  const models = await provider.request("model/list");
  const permissions = await provider.request("permissionProfile/list");
  const mcp = await provider.request("mcpServerStatus/list");
  const skills = await provider.request("skills/list");

  assert.equal(models.data.length, 3);
  assert.ok(models.data.every((model) => model.supportedReasoningEfforts.length));
  assert.equal(permissions.data.length, 3);
  assert.equal(mcp.data.length, 2);
  assert.ok(skills.data[0].skills.length >= 2);
});

test("demo model command opens a picker and updates the active scope offline", async () => {
  const conversation = createDemoConversation();
  const provider = new DemoProvider();
  const controller = new Controller({ conversation, provider });
  await controller.start();
  try {
    const listed = await controller.executeSlashCommand("/model");
    assert.equal(listed.picker.kind, "model");
    assert.equal(listed.picker.currentModel, "demo-balanced");

    const updated = await controller.executeSlashCommand("/model demo-deep high");
    assert.equal(updated.message, "Model updated");
    assert.equal(rootScope(conversation).providerState.model, "demo-deep");
    assert.equal(rootScope(conversation).providerState.effort, "high");
  } finally {
    await controller.close();
  }
});
