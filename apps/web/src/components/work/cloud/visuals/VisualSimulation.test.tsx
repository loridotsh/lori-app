import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../../../packages/contracts/fixtures/simulation-fixture.json";
import { parseVisual } from "@lori-enterprise/contracts";
import { CloudVisualActivity as VisualActivity } from "./visual-activity";
import { VisualSimulation } from "./VisualSimulation";
import type { CloudToolInvocation, SimulationBlock } from "@lori-enterprise/contracts";

const block = parseVisual(fixture)!.blocks[0] as SimulationBlock;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let hidden = false;
let intersection: IntersectionObserverCallback | undefined;
beforeEach(() => {
  frames = new Map(); nextFrame = 0; hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function tick(time: number) {
  act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); });
}
const timeSlider = () => screen.getByRole("slider", { name: "Elapsed time" }) as HTMLInputElement;
const play = () => fireEvent.click(screen.getByRole("button", { name: `Play ${block.title}` }));
const pause = () => fireEvent.click(screen.getByRole("button", { name: `Pause ${block.title}` }));

describe("interactive simulation playback", () => {
  it("starts paused and synchronizes elapsed time, sliders, outputs and the scene from one clock", () => {
    render(<VisualSimulation block={block} />);
    expect(frames.size).toBe(0);
    expect(timeSlider().value).toBe("0");
    play(); tick(100); tick(5100);
    expect(timeSlider().value).toBe("5");
    expect(screen.getByLabelText("Distance travelled").textContent).toBe("100m");
    expect(screen.getByRole("img", { name: /Traveller: 100 m/ })).toBeTruthy();
    pause();
    expect(frames.size).toBe(0);
    tick(10000);
    expect(timeSlider().value).toBe("5");
    play(); tick(20000); tick(21000);
    expect(timeSlider().value).toBe("6");
  });
  it("uses elapsed timestamps rather than frame count or monitor refresh rate", () => {
    render(<VisualSimulation block={block} />);
    play();
    for (const timestamp of [0, 8, 16, 33, 80, 1000]) tick(timestamp);
    expect(Number(timeSlider().value)).toBeCloseTo(1, 8);
  });
  it("keeps fractional playback smooth while pointer and keyboard inspection use the declared increment", () => {
    render(<VisualSimulation block={block} />);
    play(); tick(0); tick(17);
    expect(timeSlider().step).toBe("any");
    expect(Number(timeSlider().value)).toBeCloseTo(0.017,8);
    fireEvent.change(timeSlider(),{target:{value:"5.07"}});
    expect(timeSlider().value).toBe("5.1");
    fireEvent.keyDown(timeSlider(),{key:"ArrowRight"});
    expect(timeSlider().value).toBe("5.2");
    fireEvent.keyDown(timeSlider(),{key:"Home"});
    expect(timeSlider().value).toBe("0");
    fireEvent.keyDown(timeSlider(),{key:"End"});
    expect(timeSlider().value).toBe("15");
    expect(frames.size).toBe(0);
  });
  it("updates parameters live, pauses to inspect a scrubbed value, and resets only the timeline", () => {
    render(<VisualSimulation block={block} />);
    play(); tick(0); tick(5000);
    fireEvent.change(screen.getByRole("slider", { name: "Speed" }), { target: { value: "30" } });
    expect(screen.getByLabelText("Distance travelled").textContent).toBe("150m");
    expect(screen.getByLabelText("Speed in km/h").textContent).toBe("108km/h");
    fireEvent.change(timeSlider(), { target: { value: "7" } });
    expect(frames.size).toBe(0);
    expect(screen.getByLabelText("Distance travelled").textContent).toBe("210m");
    fireEvent.click(screen.getByRole("button", { name: `Reset ${block.title}` }));
    expect(timeSlider().value).toBe("0");
    expect((screen.getByRole("slider", { name: "Speed" }) as HTMLInputElement).value).toBe("30");
  });
  it("finishes at the exact endpoint, replays, and applies the declared playback rate", () => {
    render(<VisualSimulation block={{ ...block, timeline: { ...block.timeline, rate: 2 } }} />);
    play(); tick(0); tick(10000);
    expect(timeSlider().value).toBe("15");
    expect(screen.getByText("Playback complete")).toBeTruthy();
    expect(frames.size).toBe(0);
    play(); tick(20000); tick(21000);
    expect(timeSlider().value).toBe("2");
  });
  it("pauses while the document or Work mode is hidden and never jumps or resumes automatically", () => {
    const { rerender } = render(<VisualSimulation block={block} />);
    play(); tick(0); tick(1000);
    act(() => { hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(frames.size).toBe(0);
    act(() => { hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(timeSlider().value).toBe("1");
    expect(frames.size).toBe(0);
    play(); tick(20000); tick(21000);
    rerender(<VisualSimulation block={block} active={false} />);
    expect(frames.size).toBe(0);
    rerender(<VisualSimulation block={block} />);
    expect(timeSlider().value).toBe("2");
    expect(frames.size).toBe(0);
  });
  it("pauses offscreen and disconnects observers and animation work on unmount", () => {
    const disconnect = vi.fn();
    let observed: Element;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { intersection = callback; }
      observe(element: Element) { observed = element; }
      disconnect = disconnect;
    });
    const { unmount } = render(<VisualSimulation block={block} />);
    play(); tick(0); tick(1000);
    act(() => intersection!([{ target: observed!, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(frames.size).toBe(0);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("retains playback and controls while later response events refresh the saved document", () => {
    const activity: CloudToolInvocation = { id: "simulation", runId: "run", roundId: "round", callId: "call", actionHash: "hash", name: "present_visual", status: "completed", textOffset: 0, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", arguments: fixture,
      output: { kind: "cloud_visual", presented: true } };
    const { rerender, unmount } = render(<VisualActivity item={activity} />);
    play(); tick(0); tick(1000);
    rerender(<VisualActivity item={structuredClone(activity)} />);
    tick(2000);
    expect(timeSlider().value).toBe("2");
    expect(screen.getByLabelText("Distance travelled").textContent).toBe("40m");
    unmount();
    expect(frames.size).toBe(0);
  });
  it("contains a formula that becomes undefined during playback instead of showing invalid SVG or endless motion", () => {
    render(<VisualSimulation block={{ ...block, outputs: [{ label: "Result", expression: "1/(time-5)" }] }} />);
    play(); tick(0); tick(5000);
    expect(screen.getByText(/combination has an undefined result/)).toBeTruthy();
    expect(frames.size).toBe(0);
    expect((screen.getByRole("button", { name: `Play ${block.title}` }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: `Reset ${block.title}` }));
    expect(screen.getByLabelText("Result").textContent).toBe("-0.2");
  });
  it("animates a generic coordinate plane and keeps precise coordinates accessible", () => {
    render(<VisualSimulation block={{ ...block, view: { type: "plane", xLabel: "X (m)", yLabel: "Y (m)", xMin: 0, xMax: 100, yMin: 0, yMax: 100,
      items: [{ label: "Point", x: "speed*time", y: "time^2" }] } }} />);
    play(); tick(0); tick(2000);
    expect(screen.getByRole("img", { name: /X \(m\) and Y \(m\).*Point: 40, 4/ })).toBeTruthy();
    expect(screen.getByText("40, 4")).toBeTruthy();
  });
});
