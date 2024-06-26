// Param values from https://developer.mozilla.org/Add-ons/WebExtensions/API/contextualIdentities/create
const ALIBABA_CONTAINER_DETAILS = {
  name: "Alibaba",
  color: "orange",
  icon: "cart"
};

const ALIBABA_DOMAINS = [
  "alibabacloud.com",
  "alibaba.com",
  "alibaba.us",
  "alibaba.uk",
  "aliapp.org",
  "alibabacorp.com",
  "alibabagroup.com",
  "alibaba-inc.com",
  "alihealth.cn",
  "tmall.hk",
  "1688.com",
  "tmall.com",
  "taobao.com",
  "freshhema.com",
  "sunretail.com",
  "intime.com.cn",
  "aliexpress.com",
  "aliexpress.us",
  "lazada.cn",
  "trendyol.com",
  "daraz.com",
  "ele.me",
  "amap.com",
  "fliggy.com",
  "youku.com",
  "alibabapictures.com",
  "lingxigames.com",
  "damai.cn",
  "myquark.cn",
  "uc.cn",
  "cainiao.com",
  "aliyun.com",
  "dingtalk.com",
  "alibabafoundation.com",
  "ent-fund.org",
  "ae-rus.net",
  "ae-rus.ru",
  "aliexpress.ru",
  "alibaba",
  "alibabaplanet.com",
  "alicdn.com",
];

const MAC_ADDON_ID = "@testpilot-containers";

let macAddonEnabled = false;
let alibabaCookieStoreId = null;

const canceledRequests = {};
const tabsWaitingToLoad = {};
const tabStates = {};

const alibabaHostREs = [];

async function isMACAddonEnabled () {
  try {
    const macAddonInfo = await browser.management.get(MAC_ADDON_ID);
    if (macAddonInfo.enabled) {
      sendJailedDomainsToMAC();
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

async function setupMACAddonListeners () {
  browser.runtime.onMessageExternal.addListener((message, sender) => {
    if (sender.id !== "@testpilot-containers") {
      return;
    }
    switch (message.method) {
    case "MACListening":
      sendJailedDomainsToMAC();
      break;
    }
  });
  function disabledExtension (info) {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = false;
    }
  }
  function enabledExtension (info) {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = true;
    }
  }
  browser.management.onInstalled.addListener(enabledExtension);
  browser.management.onEnabled.addListener(enabledExtension);
  browser.management.onUninstalled.addListener(disabledExtension);
  browser.management.onDisabled.addListener(disabledExtension);
}

async function sendJailedDomainsToMAC () {
  try {
    return await browser.runtime.sendMessage(MAC_ADDON_ID, {
      method: "jailedDomains",
      urls: ALIBABA_DOMAINS.map((domain) => {
        return `https://${domain}/`;
      })
    });
  } catch (e) {
    // We likely might want to handle this case: https...
    return false;
  }
}

async function getMACAssignment (url) {
  if (!macAddonEnabled) {
    return false;
  }

  try {
    const assignment = await browser.runtime.sendMessage(MAC_ADDON_ID, {
      method: "getAssignment",
      url
    });
    return assignment;
  } catch (e) {
    return false;
  }
}

function cancelRequest (tab, options) {
  // we decided to cancel the request at this point, register canceled request
  canceledRequests[tab.id] = {
    requestIds: {
      [options.requestId]: true
    },
    urls: {
      [options.url]: true
    }
  };

  // since webRequest onCompleted and onErrorOccurred are not 100% reliable
  // we register a timer here to cleanup canceled requests, just to make sure we don't
  // end up in a situation where certain urls in a tab.id stay canceled
  setTimeout(() => {
    if (canceledRequests[tab.id]) {
      delete canceledRequests[tab.id];
    }
  }, 2000);
}

function shouldCancelEarly (tab, options) {
  // we decided to cancel the request at this point
  if (!canceledRequests[tab.id]) {
    cancelRequest(tab, options);
  } else {
    let cancelEarly = false;
    if (canceledRequests[tab.id].requestIds[options.requestId] ||
        canceledRequests[tab.id].urls[options.url]) {
      // same requestId or url from the same tab
      // this is a redirect that we have to cancel early to prevent opening two tabs
      cancelEarly = true;
    }
    // register this requestId and url as canceled too
    canceledRequests[tab.id].requestIds[options.requestId] = true;
    canceledRequests[tab.id].urls[options.url] = true;
    if (cancelEarly) {
      return true;
    }
  }
  return false;
}

function generateAlibabaHostREs () {
  for (let alibabaDomain of ALIBABA_DOMAINS) {
    alibabaHostREs.push(new RegExp(`^(.*\\.)?${alibabaDomain}$`));
  }
}

async function clearAlibabaCookies () {
  // Clear all alibaba cookies
  const containers = await browser.contextualIdentities.query({});
  containers.push({
    cookieStoreId: "firefox-default"
  });

  let macAssignments = [];
  if (macAddonEnabled) {
    const promises = ALIBABA_DOMAINS.map(async alibabaDomain => {
      const assigned = await getMACAssignment(`https://${alibabaDomain}/`);
      return assigned ? alibabaDomain : null;
    });
    macAssignments = await Promise.all(promises);
  }

  ALIBABA_DOMAINS.map(async alibabaDomain => {
    const alibabaCookieUrl = `https://${alibabaDomain}/`;

    // dont clear cookies for alibabaDomain if mac assigned (with or without www.)
    if (macAddonEnabled &&
        (macAssignments.includes(alibabaDomain) ||
         macAssignments.includes(`www.${alibabaDomain}`))) {
      return;
    }

    containers.map(async container => {
      const storeId = container.cookieStoreId;
      if (storeId === alibabaCookieStoreId) {
        // Don't clear cookies in the Alibaba Container
        return;
      }

      const cookies = await browser.cookies.getAll({
        domain: alibabaDomain,
        storeId
      });

      cookies.map(cookie => {
        browser.cookies.remove({
          name: cookie.name,
          url: alibabaCookieUrl,
          storeId
        });
      });
      // Also clear Service Workers as it breaks detecting onBeforeRequest
      await browser.browsingData.remove({hostnames: [alibabaDomain]}, {serviceWorkers: true});
    });
  });
}

async function setupContainer () {
  // Use existing Alibaba container, or create one

  const info = await browser.runtime.getBrowserInfo();
  if (parseInt(info.version) < 67) {
    ALIBABA_CONTAINER_DETAILS.color = "orange";
    ALIBABA_CONTAINER_DETIALS.color = "briefcase";
  }

  const contexts = await browser.contextualIdentities.query({name: ALIBABA_CONTAINER_DETAILS.name});
  if (contexts.length > 0) {
    const alibabaContext = contexts[0];
    alibabaCookieStoreId = alibabaContext.cookieStoreId;
    if (alibabaContext.color !== ALIBABA_CONTAINER_DETAILS.color ||
        alibabaContext.icon !== ALIBABA_CONTAINER_DETAILS.icon) {
          await browser.contextualIdentities.update(
            alibabaCookieStoreId,
            { color: ALIBABA_CONTAINER_DETAILS.color, icon: ALIBABA_CONTAINER_DETAILS.icon }
          );
    }
  } else {
    const context = await browser.contextualIdentities.create(ALIBABA_CONTAINER_DETAILS);
    alibabaCookieStoreId = context.cookieStoreId;
  }

  const azcStorage = await browser.storage.local.get();
  if (!azcStorage.domainsAddedToAlibabaContainer) {
    await browser.storage.local.set({ "domainsAddedToAlibabaContainer": [] });
  }
}

async function maybeReopenTab(url, tab, request) {
  const macAssigned = await getMACAssignment(url);
  if (macAssigned) {
    return;
  }

  const cookieStoreId = await shouldContainInto(url, tab);
  if (!cookieStoreId) {
    return;
  }

  if (request && shouldCancelEarly(tab, request)) {
    return { cancel: true };
  }

  await browser.tabs.create({
    url,
    cookieStoreId,
    active: tab.active,
    index: tab.index,
    windowId: tab.windowId
  });

  browser.tabs.remove(tab.id);

  return { cancel: true };
}

function isAlibabaURL (url) {
  const parsedUrl = new URL(url);
  for (let alibabaHostRE of alibabaHostREs) {
    if (alibabaHostRE.test(parsedUrl.host)) {
      return true;
    }
  }
  return false;
}

async function supportsSiteSubdomainCheck(url) {
  // No subdomains to check at this time
  return;
}

async function addDomainToAlibabaContainer (url) {
  const parsedUrl = new URL(url);
  const azcStorage = await browser.storage.local.get();
  azcStorage.domainsAddedToAlibabaContainer.push(parsedUrl.host);
  await browser.storage.local.set({"domainsAddedToAlibabaContainer": azcStorage.domainsAddedToAlibabaContainer});
  await supportSiteSubdomainCheck(parsedUrl.host);
}

async function removeDomainFromAlibabaContainer (domain) {
  const azcStorage = await browser.storage.local.get();
  const domainIndex = azcStorage.domainsAddedToAlibabaContainer.indexOf(domain);
  azcStorage.domainsAddedToAlibabaContainer.splice(domainIndex, 1);
  await browser.storage.local.set({"domainsAddedToAlibabaContainer": azcStorage.domainsAddedToAlibabaContainer});
}

async function isAddedToAlibabaContainer (url) {
  const parsedUrl = new URL(url);
  const azcStorage = await browser.storage.local.get();
  if (azcStorage.domainsAddedToAlibabaContainer.includes(parsedUrl.host)) {
    return true;
  }
  return false;
}

async function shouldContainInto (url, tab) {
  if (!url.startsWith("http")) {
    // we only handle URLs starting with http(s)
    return false;
  }

  const hasBeenAddedToAlibabaContainer = await isAddedToAlibabaContainer(url);

  if (isAlibabaURL(url) || hasBeenAddedToAlibabaContainer) {
    if (tab.cookieStoreId !== alibabaCookieStoreId) {
      // Alibaba-URL outside of Alibaba Container Tab
      // Should contain into Alibaba Container
      return alibabaCookieStoreId;
    }
  } else if (tab.cookieStoreId === alibabaCookieStoreId) {
    // Non-Alibaba-URL inside Alibaba Container Tab
    // Should contain into Default Container
    return "firefox-default";
  }

  return false;
}

async function maybeReopenAlreadyOpenTabs () {
  const tabsOnUpdated = (tabId, changeInfo, tab) => {
    if (changeInfo.url && tabsWaitingToLoad[tabId]) {
      // Tab we're waiting for switched it's url, maybe we reopen
      delete tabsWaitingToLoad[tabId];
      maybeReopenTab(tab.url, tab);
    }
    if (tab.status === "complete" && tabsWaitingToLoad[tabId]) {
      // Tab we're waiting for completed loading
      delete tabsWaitingToLoad[tabId];
    }
    if (!Object.keys(tabsWaitingToLoad).length) {
      // We're done waiting for tabs to load, remove event listener
      browser.tabs.onUpdated.removeListener(tabsOnUpdated);
    }
  };

  // Query for already open Tabs
  const tabs = await browser.tabs.query({});
  tabs.map(async tab => {
    if (tab.url === "about:blank") {
      if (tab.status !== "loading") {
        return;
      }
      // about:blank Tab is still loading, so we indicate that we wait for it to load
      // and register the event listener if we haven't yet.
      //
      // This is a workaround until platform support is implemented:
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1447551
      // https...
      tabsWaitingToLoad[tab.id] = true;
      if (!browser.tabs.onUpdated.hasListener(tabsOnUpdated)) {
        browser.tabs.onUpdated.addListener(tabsOnUpdated);
      }
    } else {
      // Tab already has an url, maybe we reopen
      maybeReopenTab(tab.url, tab);
    }
  });
}

function stripAzclid(url) {
  const strippedUrl = new URL(url);
  strippedUrl.searchParams.delete("azclid");
  return strippedUrl.href;
}

async function getActiveTab () {
  const [activeTab] = await browser.tabs.query({currentWindow: true, active: true});
  return activeTab;
}

async function windowFocusChangedListener (windowId) {
  if (windowId !== browser.windows.WINDOW_ID_NONE) {
    const activeTab = await getActiveTab();
    updateBrowserActionIcon(activeTab);
  }
}

function tabUpdateListener (tabId, changeInfo, tab) {
  updateBrowserActionIcon(tab);
}

async function updateBrowserActionIcon (tab) {

  browser.browserAction.setBadgeText({text: ""});

  const url = tab.url;
  const hasBeenAddedToAlibabaContainer = await isAddedToAlibabaContainer(url);

  if (isAlibabaURL(url)) {
    browser.storage.local.set({"CURRENT_PANEL": "on-alibaba"});
    browser.browserAction.setPopup({tabId: tab.id, popup: "./panel.html"});
  } else if (hasBeenAddedToAlibabaContainer) {
    browser.storage.local.set({"CURRENT_PANEL": "in-azc"});
  } else {
    const tabState = tabStates[tab.id];
    const panelToShow = (tabState && tabState.trackersDetected) ? "trackers-detected" : "no-trackers";
    browser.storage.local.set({"CURRENT_PANEL": panelToShow});
    browser.browserAction.setPopup({tabId: tab.id, popup: "./panel.html"});
    browser.browserAction.setBadgeBackgroundColor({color: "#A44D00"});
    if ( panelToShow === "trackers-detected" ) {
      browser.browserAction.setBadgeText({text: "!"});
    }
  }
}

async function containAlibaba (request) {
  if (tabsWaitingToLoad[request.tabId]) {
    // Cleanup just to make sure we don't get a race-condition with startup reopening
    delete tabsWaitingToLoad[request.tabId];
  }

  const tab = await browser.tabs.get(request.tabId);

  updateBrowserActionIcon(tab);

  const url = new URL(request.url);
  const urlSearchParm = new URLSearchParams(url.search);
  if (urlSearchParm.has("azclid")) {
    return {redirectUrl: stripAzclid(request.url)};
  }
  // Listen to requests and open Alibaba into its Container,
  // open other sites into the default tab context
  if (request.tabId === -1) {
    // Request doesn't belong to a tab
    return;
  }

  return maybeReopenTab(request.url, tab, request);
}

// Lots of this is borrowed from old blok code:
// https://github.com/mozilla/blok/blob/master/src/js/background.js
async function blockAlibabaSubResources (requestDetails) {
  if (requestDetails.type === "main_frame") {
    return {};
  }

  if (typeof requestDetails.originUrl === "undefined") {
    return {};
  }

  const urlIsAlibaba = isAlibabaURL(requestDetails.url);
  const originUrlIsAlibaba = isAlibabaURL(requestDetails.originUrl);

  if (!urlIsAlibaba) {
    return {};
  }

  if (originUrlIsAlibaba) {
    const message = {msg: "alibaba-domain"};
    // Send the message to the content_script
    browser.tabs.sendMessage(requestDetails.tabId, message);
    return {};
  }

  const hasBeenAddedToAlibabaContainer = await isAddedToAlibabaContainer(requestDetails.originUrl);

  if (urlIsAlibaba && !originUrlIsAlibaba) {
    if (!hasBeenAddedToAlibabaContainer ) {
      const message = {msg: "blocked-alibaba-subresources"};
      // Send the message to the content_script
      browser.tabs.sendMessage(requestDetails.tabId, message);

      tabStates[requestDetails.tabId] = { trackersDetected: true };
      return {cancel: true};
    } else {
      const message = {msg: "allowed-alibaba-subresources"};
      // Send the message to the content_script
      browser.tabs.sendMessage(requestDetails.tabId, message);
      return {};
    }
  }
  return {};
}

function setupWebRequestListeners() {
  browser.webRequest.onCompleted.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});
  browser.webRequest.onErrorOccurred.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});

  // Add the main_frame request listener
  browser.webRequest.onBeforeRequest.addListener(containAlibaba, {urls: ["<all_urls>"], types: ["main_frame"]}, ["blocking"]);

  // Add the sub-resource request listener
  browser.webRequest.onBeforeRequest.addListener(blockAlibabaSubResources, {urls: ["<all_urls>"]}, ["blocking"]);
}

function setupWindowsAndTabsListeners() {
  browser.tabs.onUpdated.addListener(tabUpdateListener);
  browser.tabs.onRemoved.addListener(tabId => delete tabStates[tabId] );
  browser.windows.onFocusChanged.addListener(windowFocusChangedListener);
}

(async function init () {
  await setupMACAddonListeners();
  macAddonEnabled = await isMACAddonEnabled();

  try {
    await setupContainer();
  } catch (error) {
    // TODO: Needs backup strategy
    // See ...
    // Sometimes this add-on is installed but doesn't get a alibabaCookieStoreId ?
    // eslint-disable-next-line no-console
    console.log(error);
    return;
  }
  clearAlibabaCookies();
  generateAlibabaHostREs();
  setupWebRequestListeners();
  setupWindowsAndTabsListeners();

  browser.runtime.onMessage.addListener( (message, {url}) => {
    if (message === "what-sites-are-added") {
      return browser.storage.local.get().then(azcStorage => azcStorage.domainsAddedToAlibabaContainer);
    } else if (message.removeDomain) {
      removeDomainFromAlibabaContainer(message.removeDomain).then( results => results );
    } else {
      addDomainToAlibabaContainer(url).then( results => results);
    }
  });

  maybeReopenAlreadyOpenTabs();

  const activeTab = await getActiveTab();
  updateBrowserActionIcon(activeTab);
})();
