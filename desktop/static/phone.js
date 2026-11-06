const phone = window.parleyPhone;
const title = document.getElementById("title");
const text = document.getElementById("text");
const code = document.getElementById("code");
const address = document.getElementById("address");
const note = document.getElementById("note");
const output = document.getElementById("output");
const actions = document.getElementById("actions");

const SVG = "http://www.w3.org/2000/svg";

function button(label, onClick, primary = false) {
  const element = document.createElement("button");
  element.textContent = label;
  element.className = primary ? "primary" : "";
  element.addEventListener("click", onClick);
  return element;
}

function setOptional(element, value) {
  element.hidden = !value;
  element.textContent = value ?? "";
}

function drawCode(qr) {
  code.hidden = !qr;
  if (!qr) {
    code.replaceChildren();
    return;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for this address");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", qr.path);
  svg.append(path);
  code.replaceChildren(svg);
}

function show(heading, paragraph, buttons, extra = {}) {
  title.textContent = heading;
  text.textContent = paragraph;
  drawCode(extra.qr);
  setOptional(address, extra.address);
  setOptional(note, extra.note);
  setOptional(output, extra.output);
  actions.replaceChildren(...buttons);
}

const turnOff = () => button("Turn off", phone.turnOff);
const checkAgain = () => button("Check again", phone.check);

const screens = {
  off: () =>
    show(
      "Use Parley from your phone",
      "Chat from your phone on any network, for as long as this computer is awake and Parley is open. It goes through Tailscale, a private network between your own devices with a free plan, and only your Tailscale account can get in.",
      [button("Turn on", phone.turnOn, true)],
      {
        note: "Your phone can then ask Claude Code or Codex to do whatever it's allowed to do on this computer.",
      },
    ),
  starting: () =>
    show("Connecting to Tailscale", "This takes a few seconds.", [turnOff()]),
  missing: () =>
    show(
      "Install Tailscale on this computer",
      "Install it and sign in. Parley notices by itself when it's ready.",
      [
        button("Download Tailscale", phone.openDownload, true),
        checkAgain(),
        turnOff(),
      ],
    ),
  signedOut: () =>
    show(
      "Sign in to Tailscale",
      "Open Tailscale on this computer, sign in and connect. Parley notices by itself when it's ready.",
      [checkAgain(), turnOff()],
    ),
  needsHttps: () =>
    show(
      "Allow HTTPS on your tailnet",
      "Tailscale asks you to allow this once, for your whole tailnet. It's what lets your phone use a secure address.",
      [
        button("Open Tailscale's page", phone.openEnableHttps, true),
        checkAgain(),
        turnOff(),
      ],
    ),
  on: ({ url, login, qr }) =>
    show(
      "Parley is ready for your phone",
      `On your phone, install Tailscale, sign in as ${login} and connect, then scan this code.`,
      [button("Copy address", phone.copyAddress), turnOff()],
      {
        qr,
        address: url,
        note: "While this is on, Parley keeps this computer from going to sleep by itself. Keep Parley open; closing the lid may still put it to sleep.",
      },
    ),
  failed: ({ output: lines }) =>
    show(
      "Phone access isn't working",
      "Parley keeps trying. This is what Tailscale said:",
      [checkAgain(), turnOff()],
      { output: lines },
    ),
};

function render(state) {
  screens[state.status](state);
}

phone.onState(render);
