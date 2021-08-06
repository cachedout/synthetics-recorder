const { chromium } = require("playwright");
const { join, resolve } = require("path");
const { existsSync } = require("fs");
const { writeFile, rm } = require("fs/promises");
const SyntheticsGenerator = require("./formatter/synthetics");
const { ipcMain: ipc } = require("electron-better-ipc");
const { fork } = require("child_process");
const { EventEmitter, once } = require("events");
const { dialog, BrowserWindow } = require("electron");

const SYNTHETICS_CLI = require.resolve("@elastic/synthetics/dist/cli");
const JOURNEY_DIR = join(__dirname, "..", "journeys");

async function launchContext() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  let closingBrowser = false;
  async function closeBrowser() {
    if (closingBrowser) return;
    closingBrowser = true;
    await browser.close();
  }

  context.on("page", (page) => {
    page.on("dialog", () => {});
    page.on("close", () => {
      const hasPage = browser
        .contexts()
        .some((context) => context.pages().length > 0);
      if (hasPage) return;
      closeBrowser().catch((e) => null);
    });
  });
  return { browser, context };
}

async function openPage(context, url) {
  const page = await context.newPage();
  if (url) {
    if (existsSync(url)) url = "file://" + resolve(url);
    else if (
      !url.startsWith("http") &&
      !url.startsWith("file://") &&
      !url.startsWith("about:")
    )
      url = "http://" + url;
    await page.goto(url);
  }
  return page;
}

function removeColorCodes(str = "") {
  return str.replace(/\u001b\[.*?m/g, "");
}

async function recordJourneys(data) {
  const { browser, context } = await launchContext();
  const actionListener = new EventEmitter();
  let actions = [];
  let eraseLastAction = false;
  let lastActionContext = null;
  actionListener.on("action", (actionInContext) => {
    const { action, pageAlias } = actionInContext;
    if (lastActionContext && lastActionContext.pageAlias === pageAlias) {
      const { action: lastAction } = lastActionContext;
      // We augment last action based on the type.
      if (
        lastActionContext &&
        action.name === "fill" &&
        lastAction.name === "fill"
      ) {
        if (action.selector === lastAction.selector) eraseLastAction = true;
      }
      if (
        lastAction &&
        action.name === "click" &&
        lastAction.name === "click"
      ) {
        if (
          action.selector === lastAction.selector &&
          action.clickCount > lastAction.clickCount
        )
          eraseLastAction = true;
      }
      if (
        lastAction &&
        action.name === "navigate" &&
        lastAction.name === "navigate"
      ) {
        if (action.url === lastAction.url) {
          // Already at a target URL.
          this._currentAction = null;
          return;
        }
      }
      for (const name of ["check", "uncheck"]) {
        // Check and uncheck erase click.
        if (lastAction && action.name === name && lastAction.name === "click") {
          if (action.selector === lastAction.selector) eraseLastAction = true;
        }
      }
    }
    lastActionContext = actionInContext;
    if (eraseLastAction) {
      actions.pop();
    }
    actions.push(actionInContext);
  });

  await context._enableRecorder({
    launchOptions: {},
    contextOptions: {},
    startRecording: true,
    showRecorder: false,
    actionListener: actionListener,
  });
  await openPage(context, data.url);

  let closingBrowser = false;
  async function closeBrowser() {
    if (closingBrowser) return;
    closingBrowser = true;
    await browser.close();
  }
  ipc.on("stop", closeBrowser);
  await once(browser, "disconnected");
  const generator = new SyntheticsGenerator(data.isSuite);
  const code = generator.generateText(actions);
  actions = [];
  return code;
}

async function onTest(data) {
  try {
    const isSuite = data.isSuite;
    const args = ["--no-headless"];
    const filePath = join(JOURNEY_DIR, "recorded.journey.js");
    if (!isSuite) {
      args.push("--inline");
    } else {
      await writeFile(filePath, data.code);
      args.unshift(filePath);
    }
    const { stdout, stdin, stderr } = fork(`${SYNTHETICS_CLI}`, args, {
      env: process.env,
      stdio: "pipe",
    });
    if (!isSuite) {
      stdin.write(data.code);
      stdin.end();
    }
    stdout.setEncoding("utf-8");
    let chunks = [];
    for await (const chunk of stdout) {
      chunks.push(removeColorCodes(chunk));
    }
    for await (const chunk of stderr) {
      chunks.push(removeColorCodes(chunk));
    }
    if (isSuite) {
      await rm(filePath, { recursive: true, force: true });
    }
    return chunks.join("");
  } catch (e) {
    console.error(e);
  }
}

async function onFileSave(code) {
  const { filePath, canceled } = await dialog.showSaveDialog(
    BrowserWindow.getFocusedWindow(),
    {
      defaultPath: "recorded.journey.js",
    }
  );

  if (!canceled) {
    await writeFile(filePath, code);
    return true;
  }
  return false;
}

function setupListeners() {
  ipc.answerRenderer("record-journey", recordJourneys);
  ipc.answerRenderer("run-journey", onTest);
  ipc.answerRenderer("save-file", onFileSave);
}

module.exports = setupListeners;
