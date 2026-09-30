import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChoiceMenu } from "@/components/ui/choice-menu";

afterEach(cleanup);
const options = [{ value: "first", label: "First round completed" }, { value: "second", label: "Second round pending" }];

function fixture() {
  const selected = vi.fn();
  function Choices() {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState("first");
    return <>
      <ChoiceMenu id="choice" label="Round" options={options} value={value} triggerLabel={value}
        open={open} onOpenChange={setOpen} restoreFocus={!open}
        onValueChange={(next) => { selected(next); setValue(next); }} />
      <button>Another action</button>
    </>;
  }
  render(<Choices />);
  return { user: userEvent.setup(), selected, trigger: screen.getByRole("button", { name: "Round: First round completed" }) };
}

it("opens a nonmodal selected radio menu and restores focus after one keyboard selection", async () => {
  const { user, trigger, selected } = fixture();
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("menu")).toHaveAttribute("aria-labelledby", "choice");
  expect(screen.getByRole("menuitemradio", { name: options[0].label })).toHaveAttribute("aria-checked", "true");
  expect(document.body.style.pointerEvents).not.toBe("none");
  await user.keyboard("{End}{Enter}");
  expect(selected).toHaveBeenCalledExactlyOnceWith("second");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveAttribute("data-value", "second");
});

it("closes with Escape, reopens immediately, and does not steal outside focus", async () => {
  const { user, trigger, selected } = fixture();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  expect(screen.getByRole("menu")).toBeVisible();
  const outside = screen.getByRole("button", { name: "Another action" });
  await user.click(outside);
  await waitFor(() => expect(outside).toHaveFocus());
  expect(screen.queryByRole("menu")).toBeNull();
  expect(selected).not.toHaveBeenCalled();
});

it.each([false, true])("restores an asynchronously enabled trigger unless the user moved on: %s", async (moveFocus) => {
  let finish: () => void = () => { throw new Error("No choice is pending"); };
  function AsyncChoices() {
    const [open, setOpen] = useState(false);
    const [disabled, setDisabled] = useState(false);
    const [value, setValue] = useState("first");
    return <>
      <div hidden={disabled}>
      <ChoiceMenu id="async" label="Page" options={options} value={value} triggerLabel={value}
        disabled={disabled} open={open} onOpenChange={setOpen} restoreFocus={!open}
        onValueChange={(next) => {
          setDisabled(true);
          finish = () => { setValue(next); setDisabled(false); };
        }} />
      </div>
      <button>Continue elsewhere</button>
    </>;
  }
  render(<AsyncChoices />);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: /^Page:/ });
  await user.click(trigger);
  await user.click(screen.getByRole("menuitemradio", { name: options[1].label }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(trigger).toBeDisabled();
  const outside = screen.getByRole("button", { name: "Continue elsewhere" });
  if (moveFocus) await user.click(outside);
  act(() => finish());
  await waitFor(() => expect(moveFocus ? outside : trigger).toHaveFocus());
});

it("supports rich disabled choices and label typeahead without selecting disabled entries", async () => {
  const selected = vi.fn();
  function RichChoices() {
    const [open, setOpen] = useState(false);
    return <ChoiceMenu id="mode" label="Mode" value="view" triggerLabel="View" open={open} onOpenChange={setOpen}
      restoreFocus options={[
        { value: "view", label: "View", icon: "eye", description: "Read and comment" },
        { value: "edit", label: "Edit", icon: "pencil", description: "Source locked", disabled: true },
        { value: "zoom", label: "Zoom", description: "A reachable last choice" },
      ]} onValueChange={selected} />;
  }
  render(<RichChoices />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Mode: View" }));
  const disabled = screen.getByRole("menuitemradio", { name: "Edit Source locked" });
  expect(disabled).toHaveAttribute("aria-disabled", "true");
  await user.click(disabled);
  expect(selected).not.toHaveBeenCalled();
  await user.keyboard("z");
  await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Zoom A reachable last choice" })).toHaveFocus());
  await user.keyboard("{Enter}");
  expect(selected).toHaveBeenCalledExactlyOnceWith("zoom");
});

it.each(["hidden", "removed", "editor"] as const)("does not steal focus after a %s trigger handoff", async destination => {
  function Handoff() {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState(false);
    return <>
      {(destination !== "removed" || !selected) && <div hidden={destination === "hidden" && selected}>
        <ChoiceMenu id="handoff" label="Target" options={options} value="first" triggerLabel="First" open={open}
          onOpenChange={setOpen} restoreFocus onValueChange={() => {
            setSelected(true);
            if (destination === "editor") document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          }} />
      </div>}
      <textarea aria-label="Editor" />
    </>;
  }
  render(<Handoff />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Target:/ }));
  await user.click(screen.getByRole("menuitemradio", { name: options[1].label }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(destination === "editor" ? screen.getByRole("textbox") : document.body);
});
