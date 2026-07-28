// popup.js — settings form. Reads/writes chrome.storage.local (this machine only).

const els = {
  key: document.getElementById("key"),
  lang: document.getElementById("lang"),
  model: document.getElementById("model"),
  cv: document.getElementById("cv"),
  save: document.getElementById("save"),
  status: document.getElementById("status"),
};

// Prefill from storage.
chrome.storage.local.get(
  ["groqApiKey", "language", "model", "cvText"],
  ({ groqApiKey, language, model, cvText }) => {
    if (groqApiKey) els.key.value = groqApiKey;
    if (language) els.lang.value = language;
    if (model) els.model.value = model;
    if (cvText) els.cv.value = cvText;
  }
);

els.save.addEventListener("click", () => {
  const groqApiKey = els.key.value.trim();
  const cvText = els.cv.value.trim();
  chrome.storage.local.set(
    { groqApiKey, cvText, language: els.lang.value, model: els.model.value },
    () => {
      const missing = [];
      if (!groqApiKey) missing.push("API key");
      if (!cvText) missing.push("CV");
      els.status.textContent = missing.length
        ? `Saved — still need: ${missing.join(", ")}.`
        : "Saved ✓  Open a LinkedIn job and click “Tailor this job”.";
      els.status.style.color = missing.length ? "#bc4c00" : "#1a7f37";
    }
  );
});
