import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OpenLoriControl } from "./open-lori-control";

describe("OpenLoriControl", () => {
  it("opens Lori with the configured organization origin", async () => {
    const user = userEvent.setup();
    render(<OpenLoriControl publicUrl="https://enterprise.acme.com" />);

    const link = screen.getByRole("link", { name: "Open Lori desktop" });
    expect(link.getAttribute("href")).toBe(
      "lori://connect?server=https%3A%2F%2Fenterprise.acme.com&protocol=1",
    );
    await user.click(link);
    expect(screen.getByText(/install or start Lori/i)).toBeTruthy();
    expect(screen.getByText(/existing connection needs none/i)).toBeTruthy();
  });

  it("does not expose manual organization-address entry after a launch attempt", async () => {
    const user = userEvent.setup();
    render(<OpenLoriControl publicUrl="https://enterprise.acme.com" />);

    await user.click(screen.getByRole("link", { name: "Open Lori desktop" }));
    expect(screen.getByText(/new installation requires one browser approval/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy organization/ })).toBeNull();
  });

  it("uses the running development app for a loopback Docker deployment", async () => {
    const user = userEvent.setup();
    render(<OpenLoriControl publicUrl="http://localhost:8180" />);

    const link = screen.getByRole("link", { name: "Open Lori desktop" });
    expect(link.getAttribute("href")).toBe(
      "http://127.0.0.1:43891/connect?server=http%3A%2F%2Flocalhost%3A8180&protocol=1",
    );
    expect(link.getAttribute("target")).toBe("_blank");

    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(
      screen.getByRole("link", { name: "Open installed Lori" }).getAttribute("href"),
    ).toBe("lori://connect?server=http%3A%2F%2Flocalhost%3A8180&protocol=1");
  });

  it("fails closed when deployment origin data is invalid", () => {
    render(<OpenLoriControl publicUrl="Not available" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/verify LORI_ADDRESS/)).toBeTruthy();
  });
});
