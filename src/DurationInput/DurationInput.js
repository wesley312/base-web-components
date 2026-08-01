/**
 * <duration-input>
 *
 * Attributes:
 *   value  - ISO 8601 duration string, e.g. "P1Y2M3DT4H5M6S". Reflects live.
 *   legend - text shown in the <legend>. Defaults to "Duration".
 *
 * Properties:
 *   .value (string, get/set) - same as the attribute.
 *
 * Events:
 *   'input'  - fired on every keystroke/change to any field.
 *   'change' - fired alongside 'input' (mirrors native form control behavior).
 *
 * Notes:
 *   - The "week" field is a convenience for the user. Since ISO 8601 does not
 *     allow combining weeks with Y/M/D/T components, weeks are folded into
 *     days (1 week = 7 days) whenever any other field is non-zero. If weeks
 *     is the only non-zero field, the compact "PnW" form is emitted instead.
 *   - Empty/zero fields are omitted from the serialized string. An all-zero
 *     duration serializes to "PT0S".
 *   - Form-associated: participates in enclosing <form> submission via
 *     ElementInternals, using the same string value.
 */
const UNITS = ["year", "month", "week", "day", "hour", "minute", "second"];
// English fallback, used if Intl.NumberFormat can't resolve a locale/unit combo.
const DEFAULT_LABELS = {
  year: "year",
  month: "month",
  week: "week",
  day: "day",
  hour: "hour",
  minute: "minute",
  second: "second",
};
// Fallback for browsers without Intl.Locale#getTextInfo — primary language
// subtags that are written right-to-left.
const RTL_LANGS = new Set([
  "ar",
  "he",
  "fa",
  "ur",
  "ps",
  "sd",
  "ug",
  "yi",
  "dv",
  "ckb",
  "arc",
  "syr",
  "nqo",
  "prs",
]);

class DurationInput extends HTMLElement {
  static formAssociated = true;
  static observedAttributes = [
    "value",
    "legend",
    "required",
    "lang",
    "labels",
    "dir",
  ];

  #internals;
  #fields;
  #labelEls;
  #langObserver; // watches ancestor lang/dir attributes so inherited locale changes are picked up
  #lastInferredDir = null; // the dir value we last set ourselves, so we can tell it apart from one user set
  #settingDir = false; // guards against our own setAttribute('dir', ...) re-triggering itself
  #suppress = false; // guards against feedback loops while syncing UI <-> attribute

  constructor() {
    super();
    this.#internals = this.attachInternals();

    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host {
          display: block;
        }
      </style>
      <fieldset part="fieldset">
        <legend part="legend"><slot name="legend">Duration</slot></legend>
        <label part="label label-year" data-unit="year">
          <input part="input input-year" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-year" data-label></span>
        </label>
        <label part="label label-month" data-unit="month">
          <input part="input input-month" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-month" data-label></span>
        </label>
        <label part="label label-week" data-unit="week">
          <input part="input input-week" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-week" data-label></span>
        </label>
        <label part="label label-day" data-unit="day">
          <input part="input input-day" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-day" data-label></span>
        </label>
        <label part="label label-hour" data-unit="hour">
          <input part="input input-hour" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-hour" data-label></span>
        </label>
        <label part="label label-minute" data-unit="minute">
          <input part="input input-minute" type="number" min="0" step="1" inputmode="numeric">
          <span part="unit unit-minute" data-label></span>
        </label>
        <label part="label label-second" data-unit="second">
          <input part="input input-second" type="number" min="0" step="any" inputmode="decimal">
          <span part="unit unit-second" data-label></span>
        </label>
      </fieldset>
    `;

    this.#fields = {};
    this.#labelEls = {};
    for (const unit of UNITS) {
      this.#fields[unit] = root.querySelector(
        `label[data-unit="${unit}"] input`,
      );
      this.#labelEls[unit] = root.querySelector(
        `label[data-unit="${unit}"] [data-label]`,
      );
      this.#fields[unit].addEventListener("input", () => this.#onFieldInput());
    }
  }

  connectedCallback() {
    this.#applyValue(
      this.hasAttribute("value") ? this.getAttribute("value") : null,
    );
    this.#updateValidity();
    this.#updateLabels();
    this.#updateDirection();
    this.#observeAncestors();
  }

  disconnectedCallback() {
    this.#langObserver?.disconnect();
    this.#langObserver = undefined;
  }

  /**
   * `this.lang`/`this.dir` only reflect THIS element's own attributes — they
   * do not inherit from an ancestor or <html lang/dir="...">, unlike CSS
   * :lang() and the inherited `direction` property. So we walk up the tree
   * ourselves, and watch every ancestor that has (or gains/loses) a `lang` or
   * `dir` attribute, plus <html>, for changes.
   */
  #observeAncestors() {
    this.#langObserver?.disconnect();
    this.#langObserver = new MutationObserver(() => {
      this.#updateLabels();
      this.#updateDirection();
    });
    for (let node = this.parentElement; node; node = node.parentElement) {
      this.#langObserver.observe(node, {
        attributes: true,
        attributeFilter: ["lang", "dir"],
      });
    }
    if (document.documentElement) {
      this.#langObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["lang", "dir"],
      });
    }
  }

  /** Nearest lang: own attribute, else nearest ancestor's (including <html>), else undefined. */
  #resolveLocale() {
    if (this.hasAttribute("lang"))
      return this.getAttribute("lang") || undefined;
    const ancestor = this.parentElement?.closest("[lang]");
    return ancestor ? ancestor.getAttribute("lang") || undefined : undefined;
  }

  /**
   * Text direction (RTL/LTR) does not follow from `lang` automatically in
   * browsers — <duration-input lang="ar"> stays LTR unless `dir` is also
   * set somewhere. So: if this element or an ancestor already has an
   * explicit `dir`, leave it alone and let normal CSS inheritance handle it.
   * Otherwise, infer direction from the resolved locale and set `dir` on
   * this element ourselves, so the grid, legend, and labels all mirror
   * correctly for RTL languages.
   */
  #updateDirection() {
    const ownDir = this.hasAttribute("dir") ? this.getAttribute("dir") : null;
    const isExplicit = ownDir !== null && ownDir !== this.#lastInferredDir;
    if (isExplicit) return; // an outside actor set this dir — never touch it

    const ancestorDir = this.parentElement?.closest("[dir]");
    if (ancestorDir) {
      // An explicit ancestor dir cascades in via normal CSS inheritance;
      // clear anything we inferred previously so it isn't shadowed.
      if (ownDir !== null) this.#setInferredDir(null);
      return;
    }

    this.#setInferredDir(DurationInput.resolveDirection(this.#resolveLocale()));
  }

  #setInferredDir(dir) {
    this.#settingDir = true;
    if (dir) this.setAttribute("dir", dir);
    else this.removeAttribute("dir");
    this.#lastInferredDir = dir; // remember exactly what we set, to recognize it as "ours" later
    this.#settingDir = false;
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === "value") {
      // Avoid re-applying a value we just produced ourselves.
      if (this.#suppress) return;
      this.#applyValue(newVal);
      this.#updateValidity();
    } else if (name === "legend") {
      // Reflect the legend attribute into the default slot content.
      this.#syncLegendSlot(newVal);
    } else if (name === "required") {
      this.#updateValidity();
    } else if (name === "lang" || name === "labels") {
      this.#updateLabels();
      if (name === "lang") this.#updateDirection();
    } else if (name === "dir") {
      // An outside actor (not us) touched `dir`. #updateDirection() reads
      // the live attribute value directly, so it will correctly recognize
      // this as explicit (leave it) or, if it was just removed, resume
      // auto-detection — no bookkeeping needed here.
      if (!this.#settingDir) this.#updateDirection();
    }
  }

  #syncLegendSlot(text) {
    let slotHost = this.querySelector('[slot="legend"]');
    if (!text) {
      if (slotHost) slotHost.remove();
      return;
    }
    if (!slotHost) {
      slotHost = document.createElement("span");
      slotHost.setAttribute("slot", "legend");
      this.appendChild(slotHost);
    }
    slotHost.textContent = text;
  }

  get value() {
    return this.getAttribute("value") || "PT0S";
  }

  set value(v) {
    this.setAttribute("value", v);
  }

  get form() {
    return this.#internals.form;
  }
  get name() {
    return this.getAttribute("name");
  }
  get validity() {
    return this.#internals.validity;
  }
  get validationMessage() {
    return this.#internals.validationMessage;
  }
  get willValidate() {
    return this.#internals.willValidate;
  }
  checkValidity() {
    return this.#internals.checkValidity();
  }
  reportValidity() {
    return this.#internals.reportValidity();
  }

  get required() {
    return this.hasAttribute("required");
  }
  set required(v) {
    this.toggleAttribute("required", Boolean(v));
  }

  /** Manual label overrides, e.g. {"year":"yr","month":"mo"}. Merges over the Intl-derived defaults. */
  get labels() {
    try {
      return JSON.parse(this.getAttribute("labels") || "{}");
    } catch {
      return {};
    }
  }
  set labels(obj) {
    this.setAttribute("labels", JSON.stringify(obj || {}));
  }

  /**
   * Resolves field labels (year/month/week/...) for the current locale and
   * writes them into the shadow DOM. Priority order:
   *   1. an explicit override in the `labels` attribute/property
   *   2. Intl.NumberFormat's own translation for that unit (locale-aware)
   *   3. the English default, if Intl can't resolve the locale/unit
   *
   * Locale comes from this element's own `lang` attribute if set, otherwise
   * the nearest ancestor with a `lang` attribute (including <html>), same as
   * how the browser resolves inherited language. Re-runs whenever this
   * element's `lang`/`labels` change, or any observed ancestor's `lang`
   * attribute is mutated.
   */
  #updateLabels() {
    const overrides = this.labels;
    const locale = this.#resolveLocale();
    for (const unit of UNITS) {
      this.#labelEls[unit].textContent =
        overrides[unit] || DurationInput.localizedUnitLabel(unit, locale);
    }
  }

  static #labelCache = new Map();

  /** Localized singular label for a duration unit */
  static localizedUnitLabel(unit, locale) {
    const key = `${locale ?? ""}:${unit}`;
    if (DurationInput.#labelCache.has(key))
      return DurationInput.#labelCache.get(key);

    let label = DEFAULT_LABELS[unit];
    try {
      const parts = new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      }).formatToParts(1);
      const unitPart = parts.find((p) => p.type === "unit");
      if (unitPart) label = unitPart.value;
    } catch {
      // Unsupported locale or unit identifier — keep the English fallback.
    }

    DurationInput.#labelCache.set(key, label);
    return label;
  }

  static #dirCache = new Map();

  /**
   * Resolves 'ltr' or 'rtl' for a locale. Prefers the standard
   * Intl.Locale#getTextInfo() (falls back to the older `.textInfo` property
   * some engines shipped first); if Intl.Locale itself isn't available or
   * throws on a malformed tag, falls back to a fixed list of RTL language
   * subtags. Defaults to 'ltr' when no locale is known at all.
   */
  static resolveDirection(locale) {
    const key = locale ?? "";
    if (DurationInput.#dirCache.has(key))
      return DurationInput.#dirCache.get(key);

    let dir = "ltr";
    if (locale) {
      try {
        if (typeof Intl.Locale === "function") {
          const loc = new Intl.Locale(locale);
          const info =
            typeof loc.getTextInfo === "function"
              ? loc.getTextInfo()
              : loc.textInfo;
          if (info?.direction) dir = info.direction;
          else throw new Error("no textInfo"); // engine has Intl.Locale but not this field
        } else {
          throw new Error("no Intl.Locale");
        }
      } catch {
        const primarySubtag = locale.toLowerCase().split("-")[0];
        dir = RTL_LANGS.has(primarySubtag) ? "rtl" : "ltr";
      }
    }

    DurationInput.#dirCache.set(key, dir);
    return dir;
  }

  /**
   * ElementInternals starts out valid and STAYS valid until you explicitly
   * call setValidity() — it does not inherit validity from the shadow-DOM
   * inputs automatically. This recomputes it from:
   *   1. each field's own native constraints (min=0, step, bad input), and
   *   2. the `required` attribute, satisfied as soon as at least one field
   *      has been given a value — including an explicit "0". A fully
   *      zeroed-out duration (e.g. "PT0S") is a legitimate, deliberate
   *      answer, not a missing one, so it must NOT trip `required`; only a
   *      component where every field is genuinely untouched should.
   */
  #updateValidity() {
    for (const unit of Object.keys(this.#fields)) {
      const input = this.#fields[unit];
      if (!input.checkValidity()) {
        this.#internals.setValidity(
          input.validity,
          `${unit} is invalid. ${input.validationMessage}`,
          input,
        );
        return;
      }
    }
    if (this.required && this.#isEmpty()) {
      this.#internals.setValidity(
        { valueMissing: true },
        "Please fill out this field.",
        this.#fields.year,
      );
      return;
    }
    this.#internals.setValidity({});
  }

  #isEmpty() {
    return UNITS.every((unit) => this.#fields[unit].value === "");
  }

  #onFieldInput() {
    const serialized = this.#serialize();
    this.#suppress = true;
    this.setAttribute("value", serialized);
    this.#suppress = false;
    this.#internals.setFormValue(serialized);
    this.#updateValidity();
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  #readFields() {
    const num = (el) => {
      const n = el.valueAsNumber;
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    return {
      year: num(this.#fields.year),
      month: num(this.#fields.month),
      week: num(this.#fields.week),
      day: num(this.#fields.day),
      hour: num(this.#fields.hour),
      minute: num(this.#fields.minute),
      second: num(this.#fields.second),
    };
  }

  #serialize() {
    let { year, month, week, day, hour, minute, second } = this.#readFields();

    // ISO 8601 doesn't allow weeks combined with other components.
    // Fold weeks into days unless weeks is the only thing specified.
    const hasOther = year || month || day || hour || minute || second;
    if (week && hasOther) {
      day += week * 7;
      week = 0;
    }

    if (week && !hasOther) {
      return `P${this.#fmt(week)}W`;
    }

    let out = "P";
    if (year) out += `${this.#fmt(year)}Y`;
    if (month) out += `${this.#fmt(month)}M`;
    if (day) out += `${this.#fmt(day)}D`;

    let time = "";
    if (hour) time += `${this.#fmt(hour)}H`;
    if (minute) time += `${this.#fmt(minute)}M`;
    if (second) time += `${this.#fmt(second)}S`;
    if (time) out += `T${time}`;

    return out === "P" ? "PT0S" : out;
  }

  #fmt(n) {
    // Trim floating point noise, keep it as a plain number string.
    return Number(n.toFixed(6)).toString();
  }

  #applyValue(str) {
    const parsed = str == null ? null : DurationInput.parse(str);
    for (const unit of UNITS) {
      const v = parsed ? parsed[unit] : undefined;
      this.#fields[unit].value = v !== undefined ? String(v) : "";
    }
    // Form submission still needs a concrete duration even when nothing was
    // typed, so an untouched/invalid value submits as the zero duration.
    this.#internals.setFormValue(parsed ? str : "PT0S");
  }

  /**
   * Parses an ISO 8601 duration string into a plain object, or null if
   * invalid. Each unit is `undefined` if that designator was absent from
   * the string, or a number (possibly 0) if it was present — e.g. "PT0S"
   * gives `{ second: 0, year: undefined, ... }`, distinct from a unit that
   * was never mentioned at all. This distinction matters for #applyValue
   * (explicit zero should render as "0", not blank) and for `required`
   * (a field showing an explicit "0" counts as filled in).
   */
  static parse(str) {
    if (typeof str !== "string") return null;
    const re =
      /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
    const m = re.exec(str.trim());
    if (!m) return null;
    const [, y, mo, w, d, h, mi, s] = m;
    // Raw capture groups are undefined (absent) or a numeric string, even
    // "0" — so this truthiness check already only rejects "P"/"PT" with no
    // designators at all, it does not reject an explicit zero like "PT0S".
    if (!y && !mo && !w && !d && !h && !mi && !s) return null;
    const num = (g) => (g === undefined ? undefined : Number(g));
    return {
      year: num(y),
      month: num(mo),
      week: num(w),
      day: num(d),
      hour: num(h),
      minute: num(mi),
      second: num(s),
    };
  }
}

customElements.define("duration-input", DurationInput);
