import { markHardStop } from "./output-sink.js";
const EGO_ERROR_CODES = [
  "EGO_BROWSER_UNAVAILABLE",
  "EGO_CDP_CHANNEL_UNAVAILABLE",
  "EGO_CDP_SEND_FAILED",
  "EGO_INVALID_ARGUMENT",
  "EGO_INVALID_RESULT_PAYLOAD",
  "EGO_OPERATION_FAILED",
  "EGO_RESULT_CONVERSION_FAILED",
  "EGO_SNAPSHOT_FAILED",
  "EGO_TASK_HOST_DISCONNECTED",
  "EGO_TASK_SPACE_INACTIVE",
  "EGO_TASK_SPACE_NAME_IN_USE",
  "EGO_TASK_SPACE_NOT_FOUND",
  "EGO_TASK_SPACE_NOT_SELECTED",
  "EGO_TASK_SPACE_UNAVAILABLE",
  "EGO_TASK_SPACE_USER_IN_CONTROL",
  "EGO_WEB_CONTENTS_UNAVAILABLE"
];
const EGO_ERROR_MESSAGES = {
  // The native code does not say who ended the task or moved control: the
  // agent's own task.finish() / task.handOff() produce the same codes as user
  // actions in the browser. Keep this wording neutral about the cause.
  EGO_TASK_SPACE_INACTIVE: [
    "This task space is no longer assigned to the agent: its task has ended, either through task.finish() or by the user, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around \u2014 do not retry and do not take ownership back on your own. takeOverTaskSpace() cannot resume an ended task.",
    "Wait until the user explicitly asks you to continue in this space, then claim it and resume:",
    "  const task = await claimTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Done" if your harness supports it; otherwise tell them: "This task has ended and the space is yours. Reply 'continue' if you want me to resume in it."`
  ].join("\n"),
  EGO_TASK_SPACE_USER_IN_CONTROL: [
    "Control of this task space is with the user, either through task.handOff() or a takeover in the browser, so browser commands are paused.",
    "This is a hard stop, not an obstacle to route around \u2014 do not retry and do not take control back on your own.",
    "Wait until the user explicitly asks you to continue, then take control back and resume:",
    "  const task = await takeOverTaskSpace(spaceId)",
    "",
    `Offer the user choices like "Continue" or "Finish task" if your harness supports it; otherwise tell them: "You now control this task space. Reply 'continue' when ready and I will resume."`
  ].join("\n")
};
const USER_CONTROL_GUIDANCE = EGO_ERROR_MESSAGES.EGO_TASK_SPACE_USER_IN_CONTROL;
const USER_CONTROL_REASON_MESSAGES = Object.freeze({
  notifications: permissionPrompt("notifications"),
  location: permissionPrompt("location access"),
  camera: permissionPrompt("camera access"),
  microphone: permissionPrompt("microphone access"),
  pan_tilt_zoom_microphone: permissionPrompt(
    "camera control and microphone access"
  ),
  midi: permissionPrompt("MIDI device access"),
  bluetooth: userPromptGuidance(
    "A browser device chooser for Bluetooth has appeared."
  ),
  usb: userPromptGuidance("A browser device chooser for USB has appeared."),
  serial: userPromptGuidance(
    "A browser port chooser for serial access has appeared."
  ),
  hid: userPromptGuidance("A browser device chooser for HID has appeared."),
  protocol_handler: permissionPrompt("protocol handler registration"),
  manual_takeover: USER_CONTROL_GUIDANCE
});
function permissionPrompt(access) {
  return userPromptGuidance(
    `A browser permission prompt for ${access} has appeared.`
  );
}
function userPromptGuidance(firstLine) {
  return [
    firstLine,
    "The user now controls this task space. Wait for the user to handle the prompt.",
    "Resume only after the user confirms, using takeOverTaskSpace(spaceId)."
  ].join("\n");
}
function isEgoErrorCode(value) {
  return typeof value === "string" && EGO_ERROR_CODES.includes(value);
}
function egoErrorCode(err) {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? err : void 0;
  }
  if (err && typeof err === "object") {
    const code = err.error_code;
    if (typeof code === "string" && code) return code;
  }
  return void 0;
}
function resolveEgoError(err) {
  const code = egoErrorCode(err);
  const message = (code === "EGO_TASK_SPACE_USER_IN_CONTROL" ? resolveUserControlMessage(err) : isEgoErrorCode(code) ? EGO_ERROR_MESSAGES[code] : void 0) ?? nativeErrorText(err) ?? code ?? "Unknown ego error";
  return { code, message };
}
function resolveUserControlMessage(err) {
  const nativeText = nativeErrorText(err);
  if (nativeText && Object.hasOwn(USER_CONTROL_REASON_MESSAGES, nativeText)) {
    return USER_CONTROL_REASON_MESSAGES[nativeText];
  }
  return USER_CONTROL_GUIDANCE;
}
function isEgoUserControlError(err) {
  return egoErrorCode(err) === "EGO_TASK_SPACE_USER_IN_CONTROL";
}
async function probeAgentControl(invokeSnapshot) {
  let result;
  try {
    result = await invokeSnapshot();
  } catch (error) {
    if (isEgoUserControlError(error)) return false;
    throw error;
  }
  if (isResolvedEgoError(result)) {
    if (isEgoUserControlError(result)) return false;
    throw buildEgoError(result);
  }
  return true;
}
function isResolvedEgoError(value) {
  return value !== null && typeof value === "object" && "error" in value && value.error != null;
}
function isEgoHardStopCode(code) {
  return code === "EGO_TASK_SPACE_USER_IN_CONTROL" || code === "EGO_TASK_SPACE_INACTIVE";
}
function buildEgoError(err, op) {
  const { code, message } = resolveEgoError(err);
  if (isEgoHardStopCode(code)) {
    markHardStop(message);
  }
  const error = new Error(
    op ? `${op}: ${message}` : message
  );
  if (code) error.error_code = code;
  return error;
}
async function invokeEgo(op, invoke) {
  let result;
  try {
    result = await invoke();
  } catch (error) {
    throw buildEgoError(error, op);
  }
  if (result && typeof result === "object" && "error" in result && result.error != null) {
    throw buildEgoError(result, op);
  }
  return result;
}
function nativeErrorText(err) {
  if (typeof err === "string") {
    return isEgoErrorCode(err) ? void 0 : err;
  }
  if (err && typeof err === "object") {
    const obj = err;
    if (obj.error != null) return formatEgoError(obj.error);
    if (typeof obj.message === "string" && obj.message) return obj.message;
  }
  return void 0;
}
function formatEgoError(err) {
  if (err == null) return String(err);
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
export {
  EGO_ERROR_CODES,
  buildEgoError,
  egoErrorCode,
  formatEgoError,
  invokeEgo,
  isEgoErrorCode,
  isEgoUserControlError,
  probeAgentControl,
  resolveEgoError
};
