import { inspect } from "node:util";
function formatCliLogValue(value) {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, {
    depth: 6,
    breakLength: Infinity,
    compact: true
  });
}
export {
  formatCliLogValue
};
