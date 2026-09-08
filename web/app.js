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
  await createClinician();
});

document.querySelector("#factor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const label = document.querySelector("#factor-label").value.trim();
  if (!label) {
    showMessage("Enter a local patient label.", true);
    return;
  }
  createPatientFactor(label);
  event.target.reset();
  showMessage("Synthetic patient factor created in this browser.");
});

document.querySelector("#enroll-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await enrollSelectedPatient(document.querySelector("#enroll-factor").value);
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#append-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const factorId = document.querySelector("#append-factor").value;
  const resourceType = document.querySelector("#resource-type").value;
  const description = document.querySelector("#clinical-code").value.trim();
  const status = document.querySelector("#clinical-status").value.trim();

  try {
    await appendResource(factorId, buildResource(resourceType, description, status));
    showMessage("FHIR entry encrypted and appended.");
    event.target.reset();
    refreshFactorSelects();
  } catch (error) {
    showMessage(error.message, true);
  }
});

document.querySelector("#timeline-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadTimeline(document.querySelector("#timeline-factor").value);
});

document.querySelector("#sample-flow").addEventListener("click", async () => {
  try {
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
    await loadTimeline(factor.id);
    showMessage("Sample encrypted patient timeline created.");
  } catch (error) {
    showMessage(error.message, true);
  }
});

async function createClinician(showSuccess = true) {
  try {
    const credential = await api("/api/clinicians", {});
    localStorage.setItem(STORAGE_KEYS.clinician, JSON.stringify(credential));
    refreshLocalStatus();
    if (showSuccess) {
      showMessage("Local clinician credential created.");
    }
    return credential;
  } catch (error) {
    showMessage(error.message, true);
    throw error;
  }
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
    showMessage("Synthetic fingerprint capture completed.");
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
  try {
    const result = await api("/api/timeline", getAccess(factorId));
    renderTimeline(result.entries);
    showMessage(`Verified ${result.entries.length} timeline entries.`);
  } catch (error) {
    renderTimeline([]);
    showMessage(error.message, true);
  }
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

  if (!entries.length) {
    results.className = "timeline-list empty-state";
    results.textContent = "No verified timeline entries.";
    return;
  }

  results.className = "timeline-list";
  entries.forEach(({ event, resource }, index) => {
    const card = document.createElement("article");
    card.className = "timeline-entry";

    const heading = document.createElement("h2");
    heading.textContent = `${index + 1}. ${friendlyResourceType(resource.resourceType)}`;
    card.append(heading);

    const description = document.createElement("p");
    description.textContent = resourceDescription(resource);
    card.append(description);

    const details = document.createElement("dl");
    appendDetail(details, "Recorded", new Date(event.recordedAt).toLocaleString());
    appendDetail(details, "FHIR ID", resource.id ?? "Not supplied");
    appendDetail(details, "Event", shortId(event.eventId));
    appendDetail(
      details,
      "Previous",
      event.parents.length ? event.parents.map(shortId).join(", ") : "Enrollment root",
    );
    appendDetail(details, "Verification", "Signature, MAC, hash, and lineage valid");
    card.append(details);
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

    select.disabled = false;
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
    ? `Credential ${shortId(clinician.credentialId)}`
    : "No credential available.";
  factorCount.textContent = String(factors.length);
}

function showSection(sectionId) {
  document.querySelectorAll(".page").forEach((section) => {
    section.classList.toggle("active", section.id === sectionId);
  });
  document.querySelectorAll("nav [data-section-link]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sectionLink === sectionId);
  });
  history.replaceState(null, "", `#${sectionId}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showMessage(text, isError = false) {
  message.hidden = false;
  message.className = `message${isError ? " error" : ""}`;
  message.textContent = text;
  window.clearTimeout(showMessage.timeout);
  showMessage.timeout = window.setTimeout(() => {
    message.hidden = true;
  }, 6000);
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
  showSection(location.hash.slice(1) || "dashboard");

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
