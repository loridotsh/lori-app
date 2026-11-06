import { afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy* and waitFor give up after one second by default, which a busy machine (a dev stack and
// Docker running beside the suite) can exceed for work that is not slow. Waiting longer costs
// nothing when the element is there.
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
});

if (
  typeof HTMLDialogElement !== "undefined" &&
  !HTMLDialogElement.prototype.showModal
) {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
}

if (
  typeof HTMLDialogElement !== "undefined" &&
  !HTMLDialogElement.prototype.close
) {
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
