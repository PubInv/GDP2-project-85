const STORAGE_KEYS = {
  clinician: "gphr.poc.clinician",
  factors: "gphr.poc.patient-factors",
  activeFactor: "gphr.poc.active-patient-factor",
};

const message = document.querySelector("#message");
const clinicianStatus = document.querySelector("#clinician-status");
const clinicianId = document.querySelector("#clinician-id");
const factorCount = document.querySelector("#factor-count");
const factorSelects = [
  document.querySelector("#enroll-factor"),
  document.querySelector("#append-factor"),
  document.querySelector("#timeline-factor"),
];
const factorSelectionDetails = [
  document.querySelector("#enroll-factor-detail"),
  document.querySelector("#append-factor-detail"),
  document.querySelector("#timeline-factor-detail"),
];
let actionPending = false;
let timelineRevision = 0;

document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("#main-content").focus();
});

factorSelects.forEach((select) => {
  select.addEventListener("change", () => {
    setActiveFactor(select.value);
  });
});

document.querySelectorAll("[data-section-link]").forEach((element) => {
  element.addEventListener("click", (event) => {
    event.preventDefault();
    showSection(element.dataset.sectionLink);
  });
});

document.querySelector("#clinician-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runAction(() => createClinician(), "Creating the local clinician credential...");
});

document.querySelector("#factor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const label = document.querySelector("#factor-label").value.trim();
  if (!label) {
    showMessage("Enter a local patient label.", true);
    return;
  }
  try {
    createPatientFactor(label);
    event.target.reset();
    showMessage("Synthetic factor created. Next, enroll its encrypted record below.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runAction(async () => {
    await enrollSelectedPatient(document.querySelector("#enroll-factor").value);
    showSection("append");
    showMessage("Record enrolled. Next, add a synthetic entry.");
  }, "Enrolling the encrypted record...");
});

document.querySelector("#append-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const factorId = document.querySelector("#append-factor").value;
  const resourceType = document.querySelector("#resource-type").value;
  const description = document.querySelector("#clinical-code").value.trim();
  const status = document.querySelector("#clinical-status").value.trim();

  await runAction(async () => {
    if (!description || !status) {
      throw new Error("Enter a synthetic description and status; neither can be blank.");
    }
    clearTimeline();
    await appendResource(factorId, buildResource(resourceType, description, status));
    event.target.reset();
    refreshFactorSelects();
    showSection("timeline");
    showMessage("Entry encrypted and appended. Choose Unlock and verify to read the updated history.");
  }, "Encrypting and appending the entry...");
});

document.querySelector("#timeline-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await runAction(
    () => loadTimeline(document.querySelector("#timeline-factor").value),
    "Unlocking and verifying the history...",
  );
});

document.querySelector("#sample-flow").addEventListener("click", async () => {
  await runAction(async () => {
    if (!getClinician()) {
      await createClinician(false);
    }
    const factor = createPatientFactor(
      `Sample patient ${new Date().toLocaleTimeString()}`,
      false,
    );
    await enrollSelectedPatient(factor.id, false);
    await appendResource(
      factor.id,
      buildResource(
        "AllergyIntolerance",
        "Synthetic penicillin allergy",
        "active",
      ),
    );
    await appendResource(
      factor.id,
      buildResource("Condition", "Synthetic asthma example", "active"),
    );
    showSection("timeline");
    document.querySelector("#timeline-factor").value = factor.id;
    if (await loadTimeline(factor.id)) {
      showMessage("Sample ready: two encrypted entries with verified history. You can now add another entry.");
    }
  }, "Creating a sample record and two encrypted entries...");
});

document.querySelector("#hide-timeline").addEventListener("click", () => {
  clearTimeline("Timeline hidden. Choose Unlock and verify to display it again.");
  showMessage("Decrypted timeline removed from this view.");
});

window.addEventListener("hashchange", () => {
  showSection(location.hash.slice(1), { updateHistory: false });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeline("Timeline hidden when you left this tab. Unlock and verify again.");
  }
});

async function runAction(action, pendingMessage) {
  if (actionPending) {
    showMessage("An operation is already in progress. Please wait.");
    return;
  }
  actionPending = true;
  const controls = [...document.querySelectorAll("form input, form select, form button, #sample-flow")];
  const disabledStates = controls.map((control) => control.disabled);
  controls.forEach((control) => {
    control.disabled = true;
  });
  document.querySelectorAll("form").forEach((form) => form.setAttribute("aria-busy", "true"));
  showMessage(pendingMessage);
  try {
    await action();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    actionPending = false;
    controls.forEach((control, index) => {
      control.disabled = disabledStates[index];
    });
    document.querySelectorAll("form").forEach((form) => form.removeAttribute("aria-busy"));
    refreshFactorSelects();
    refreshLocalStatus();
  }
}

async function createClinician(showSuccess = true) {
  if (getClinician()) {
    throw new Error("A clinician credential already exists. It is retained so existing records remain accessible.");
  }
  const credential = await api("/api/clinicians", {});
  localStorage.setItem(STORAGE_KEYS.clinician, JSON.stringify(credential));
  clearTimeline();
  refreshLocalStatus();
  if (showSuccess) {
    showMessage("Local clinician credential created. Next, create a synthetic patient factor.");
  }
  return credential;
}

function createPatientFactor(label, showSuccess = true) {
  const factors = getFactors();
  const factor = {
    id: crypto.randomUUID(),
    label,
    token: randomToken(),
    createdAt: new Date().toISOString(),
  };
  factors.push(factor);
  localStorage.setItem(STORAGE_KEYS.factors, JSON.stringify(factors));
  setActiveFactor(factor.id);
  refreshLocalStatus();
  if (showSuccess) {
    showMessage("Synthetic patient factor created.");
  }
  return factor;
}

async function enrollSelectedPatient(factorId, showSuccess = true) {
  const access = getAccess(factorId);
  await api("/api/enroll", access);
  if (showSuccess) {
    showMessage("Encrypted patient record enrolled.");
  }
}

async function appendResource(factorId, resource) {
  const access = getAccess(factorId);
  return api("/api/records", { ...access, resource });
}

async function loadTimeline(factorId) {
  clearTimeline("Verifying the selected record. No entries are displayed until verification completes.");
  const revision = timelineRevision;
  try {
    const result = await api("/api/timeline", getAccess(factorId));
    // Navigation or factor changes invalidate an in-flight decrypted response.
    if (revision !== timelineRevision) {
      return false;
    }
    if (document.hidden || !document.querySelector("#timeline").classList.contains("active")) {
      clearTimeline("Timeline hidden. Return to Timeline and choose Unlock and verify.");
      return false;
    }
    renderTimeline(result.entries);
    showMessage(`Verified ${result.entries.length} timeline ${result.entries.length === 1 ? "entry" : "entries"}.`);
    return true;
  } catch (error) {
    if (revision === timelineRevision) {
      clearTimeline("Timeline could not be verified. Check both factors and enrollment, then try again.");
    }
    throw error;
  }
}

function clearTimeline(text = "No timeline loaded. Select an enrolled factor and choose Unlock and verify.") {
  timelineRevision += 1;
  const results = document.querySelector("#timeline-results");
  results.className = "timeline-list empty-state";
  results.textContent = text;
  const state = document.querySelector("#timeline-state");
  state.className = "state-label";
  state.textContent = "Locked · No decrypted entries displayed";
}

function getAccess(factorId) {
  const clinician = getClinician();
  if (!clinician) {
    throw new Error("Create a local clinician credential first.");
  }
  const factor = getFactors().find((candidate) => candidate.id === factorId);
  if (!factor) {
    throw new Error("Create and select a synthetic patient factor first.");
  }
  return { biometricToken: factor.token, clinician };
}

function buildResource(resourceType, description, status) {
  const id = `synthetic-${crypto.randomUUID()}`;
  const subject = { reference: "Patient/ephemeral" };

  switch (resourceType) {
    case "AllergyIntolerance":
      return {
        resourceType,
        id,
        patient: subject,
        clinicalStatus: { text: status },
        code: { text: description },
      };
    case "Condition":
      return {
        resourceType,
        id,
        subject,
        clinicalStatus: { text: status },
        code: { text: description },
      };
    case "Immunization":
      return {
        resourceType,
        id,
        patient: subject,
        status,
        vaccineCode: { text: description },
        occurrenceDateTime: new Date().toISOString(),
      };
    case "MedicationStatement":
      return {
        resourceType,
        id,
        subject,
        status,
        medicationCodeableConcept: { text: description },
      };
    case "Observation":
      return {
        resourceType,
        id,
        subject,
        status,
        code: { text: description },
        valueString: description,
      };
    default:
      throw new Error("Unsupported FHIR resource type.");
  }
}

function renderTimeline(entries) {
  const results = document.querySelector("#timeline-results");
  results.replaceChildren();
  const state = document.querySelector("#timeline-state");
  state.className = "state-label verified";
  state.textContent = `Verified · ${entries.length} ${entries.length === 1 ? "entry" : "entries"} · Integrity checks passed`;

  if (!entries.length) {
    results.className = "timeline-list empty-state";
    results.textContent = "Record verified, with no entries yet. Use Add entry to create its first synthetic record.";
    return;
  }

  results.className = "timeline-list";
  entries.forEach(({ event, resource }, index) => {
    const card = document.createElement("article");
    card.className = "timeline-entry";

    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const recorded = document.createElement("time");
    recorded.dateTime = event.recordedAt;
    recorded.textContent = new Date(event.recordedAt).toLocaleString();
    const badge = document.createElement("span");
    badge.className = "verification-badge";
    badge.textContent = "Integrity verified";
    meta.append(recorded, badge);
    card.append(meta);

    const heading = document.createElement("h2");
    heading.textContent = `${index + 1}. ${friendlyResourceType(resource.resourceType)}`;
    card.append(heading);

    const description = document.createElement("p");
    description.textContent = resourceDescription(resource);
    card.append(description);

    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Inspect verification details";
    const details = document.createElement("dl");
    appendDetail(details, "FHIR ID", resource.id ?? "Not supplied");
    appendDetail(details, "Event", shortId(event.eventId));
    appendDetail(
      details,
      "Previous",
      event.parents.length ? event.parents.map(shortId).join(", ") : "Enrollment root",
    );
    appendDetail(details, "Verification", "Signature, MAC, hash, and lineage valid");
    disclosure.append(summary, details);
    card.append(disclosure);
    results.append(card);
  });
}

function appendDetail(list, term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function resourceDescription(resource) {
  return (
    resource.code?.text ??
    resource.vaccineCode?.text ??
    resource.medicationCodeableConcept?.text ??
    resource.valueString ??
    "Encrypted FHIR entry"
  );
}

function friendlyResourceType(resourceType) {
  return resourceType.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function shortId(value) {
  return `${value.slice(0, 10)}…`;
}

function getClinician() {
  const stored = localStorage.getItem(STORAGE_KEYS.clinician);
  return stored ? JSON.parse(stored) : null;
}

function getFactors() {
  const stored = localStorage.getItem(STORAGE_KEYS.factors);
  if (!stored) {
    return [];
  }

  try {
    const factors = JSON.parse(stored);
    if (!Array.isArray(factors)) {
      throw new Error("Patient factor storage must be an array.");
    }
    return factors.filter(
      (factor) =>
        typeof factor === "object" &&
        factor !== null &&
        typeof factor.id === "string" &&
        typeof factor.label === "string" &&
        typeof factor.token === "string",
    );
  } catch {
    localStorage.removeItem(STORAGE_KEYS.factors);
    localStorage.removeItem(STORAGE_KEYS.activeFactor);
    showMessage(
      "Invalid saved patient-factor state was cleared. Simulate the patient factor again.",
      true,
    );
    return [];
  }
}

function refreshFactorSelects(selectedId) {
  const factors = getFactors();
  const requestedId =
    selectedId ?? localStorage.getItem(STORAGE_KEYS.activeFactor) ?? "";
  const activeFactor =
    factors.find((factor) => factor.id === requestedId) ?? factors[0];

  if (activeFactor) {
    localStorage.setItem(STORAGE_KEYS.activeFactor, activeFactor.id);
  } else {
    localStorage.removeItem(STORAGE_KEYS.activeFactor);
  }

  factorSelects.forEach((select) => {
    select.replaceChildren();

    if (!factors.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Create a synthetic patient factor first";
      option.selected = true;
      select.append(option);
      select.disabled = true;
      return;
    }

    select.disabled = actionPending;
    factors.forEach((factor) => {
      const option = document.createElement("option");
      option.value = factor.id;
      option.textContent = factor.label;
      option.selected = factor.id === activeFactor.id;
      select.append(option);
    });
  });

  factorSelectionDetails.forEach((detail) => {
    detail.textContent = activeFactor
      ? `Selected: ${activeFactor.label} · simulated ${new Date(activeFactor.createdAt).toLocaleString()}`
      : "No patient factor is available.";
  });
}

function setActiveFactor(factorId) {
  clearTimeline("Patient selection changed. Unlock and verify the selected record.");
  const factor = getFactors().find((candidate) => candidate.id === factorId);
  if (!factor) {
    localStorage.removeItem(STORAGE_KEYS.activeFactor);
    refreshFactorSelects();
    return;
  }

  localStorage.setItem(STORAGE_KEYS.activeFactor, factor.id);
  refreshFactorSelects(factor.id);
}

function refreshLocalStatus() {
  const clinician = getClinician();
  const factors = getFactors();
  clinicianStatus.textContent = clinician ? "Available locally" : "Not created";
  clinicianId.textContent = clinician
    ? `Credential ${shortId(clinician.credentialId)} is retained for existing records. Keep this browser's demo data.`
    : "No credential available.";
  document.querySelector("#create-clinician").disabled = actionPending || Boolean(clinician);
  factorCount.textContent = String(factors.length);
}

function showSection(sectionId, { focus = true, updateHistory = true } = {}) {
  const sections = [...document.querySelectorAll(".page")];
  if (!sections.some((section) => section.id === sectionId)) {
    sectionId = "dashboard";
    history.replaceState(null, "", "#dashboard");
  }
  const previousSection = document.querySelector(".page.active");
  if (previousSection?.id !== sectionId) {
    clearTimeline();
  }
  document.querySelectorAll(".page").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });
  document.querySelectorAll("nav [data-section-link]").forEach((button) => {
    const active = button.dataset.sectionLink === sectionId;
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  if (updateHistory && location.hash !== `#${sectionId}`) {
    history.pushState(null, "", `#${sectionId}`);
  }
  if (focus) {
    const heading = document.querySelector(`#${sectionId} h1`);
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showMessage(text, isError = false) {
  message.hidden = false;
  message.className = `message${isError ? " error" : ""}`;
  message.setAttribute("role", isError ? "alert" : "status");
  message.setAttribute("aria-live", isError ? "assertive" : "polite");
  message.textContent = text;
  if (isError) {
    message.tabIndex = -1;
    message.focus();
  }
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? `Request failed with status ${response.status}.`);
  }
  return result;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function initialize() {
  refreshFactorSelects();
  refreshLocalStatus();
  showSection(location.hash.slice(1) || "dashboard", { focus: false, updateHistory: false });

  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    document.querySelector("#server-status").textContent =
      response.ok && status.status === "ok" ? "Running locally" : "Unavailable";
  } catch {
    document.querySelector("#server-status").textContent = "Unavailable";
  }
}

initialize();
