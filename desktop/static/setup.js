const setup = window.parleySetup;
const title = document.getElementById("title");
const text = document.getElementById("text");
const output = document.getElementById("output");
const actions = document.getElementById("actions");

function button(label, onClick, primary = false) {
  const element = document.createElement("button");
  element.textContent = label;
  element.className = primary ? "primary" : "";
  element.addEventListener("click", onClick);
  return element;
}

function show(heading, paragraph, buttons = [], lines) {
  title.textContent = heading;
  text.textContent = paragraph;
  output.hidden = !lines;
  output.textContent = lines ?? "";
  output.scrollTop = output.scrollHeight;
  actions.replaceChildren(...buttons);
}

const screens = {
  starting: () => show("Starting Parley", "This takes a few seconds."),
  missing: () =>
    show(
      "Parley needs Claude Code",
      "Chats here run on Claude Code, on your own Claude plan. Parley can install it for you with Anthropic's official installer.",
      [
        button("Install Claude Code", setup.install, true),
        button("Install it myself", setup.openInstallDocs),
        button("Check again", setup.retry),
      ],
    ),
  signedOut: () =>
    show(
      "Sign in to Claude Code",
      "Your browser will open so you can sign in with your Claude account. Parley never sees your password.",
      [
        button("Sign in", setup.signIn, true),
        button("Check again", setup.retry),
      ],
    ),
  working: ({ title: heading, lines }) =>
    show(
      heading,
      "This can take a minute. Follow any steps in your browser.",
      [button("Cancel", setup.retry)],
      lines.join("\n"),
    ),
  error: ({ title: heading, output: lines, logPath }) =>
    show(
      heading,
      `Trying again often fixes this. The full log is at ${logPath}.`,
      [
        button("Try again", setup.retry, true),
        button("Show log", setup.showLogs),
      ],
      lines || undefined,
    ),
};

setup.onState((state) => screens[state.screen](state));
