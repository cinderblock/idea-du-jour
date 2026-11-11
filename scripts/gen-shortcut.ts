/**
 * Generate the "Record to idj" Apple Shortcut as an unsigned .shortcut plist.
 *
 *   bun run shortcut:build        -> build/record-to-idj.unsigned.shortcut
 *   bun run shortcut:sign         -> public/record-to-idj.shortcut (signed, on the mini)
 *
 * What it does on the phone:
 *   1. Finds this phone's device ID in iCloud Drive (Shortcuts/idj/device-id.txt),
 *      or on first run makes one (SHA-256 of four random numbers and the time)
 *      and saves it there.
 *   2. Records audio (Normal quality, starts at once, stops on tap). If you
 *      stopped within 2 seconds it asks for typed text instead and POSTs
 *      {text} as JSON; otherwise it saves the recording to iCloud Drive
 *      (Shortcuts/idj/) and POSTs the file.
 *   3. Shows the server's `message` as a notification ("Saved to idj", or
 *      "approve this phone at …/devices" while the phone is new, or an error),
 *      or the whole answer if there's no message.
 *
 * No token and no install questions: the phone pairs instead. Every capture
 * sends X-Idj-Device-Id, X-Idj-Device-Name (URL-encoded: a non-ASCII header can
 * make iOS drop the request) and X-Idj-Device-Model. The server holds a new
 * phone's captures until it's approved on /devices. The file holds no secret,
 * so it's served publicly.
 *
 * Signing needs a Mac signed into iCloud (iOS imports only Apple-signed
 * files); scripts/sign-shortcut.sh uses the Mac mini (ssh alias `mini`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE_URL = process.env.IDJ_BASE_URL ?? 'https://idj.isozilla.com'
const OUT = process.env.OUT ?? 'build/record-to-idj.unsigned.shortcut'
/** Stopping the recorder within this many seconds means "I want to type". */
const TYPE_INSTEAD_SECONDS = 2

/** U+FFFC OBJECT REPLACEMENT CHARACTER: where a variable goes inside text. */
const OBJ = '￼'

// --- minimal plist serializer (Shortcuts files are plain plists) -------------

type P = string | number | boolean | P[] | { [k: string]: P }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function plist(v: P, indent = 1): string {
  const pad = '\t'.repeat(indent)
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}<array/>`
    return `${pad}<array>\n${v.map((x) => plist(x, indent + 1)).join('\n')}\n${pad}</array>`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return `${pad}<dict/>`
    const body = keys
      .map((k) => `${'\t'.repeat(indent + 1)}<key>${esc(k)}</key>\n${plist(v[k], indent + 1)}`)
      .join('\n')
    return `${pad}<dict>\n${body}\n${pad}</dict>`
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`
  }
  if (typeof v === 'boolean') return `${pad}<${v ? 'true' : 'false'}/>`
  return `${pad}<string>${esc(v)}</string>`
}

// --- Shortcuts value helpers -------------------------------------------------

/** An action's output, referenced by the action's UUID and output name. */
type Output = { uuid: string; name: string }

const ref = (o: Output) => ({ OutputUUID: o.uuid, Type: 'ActionOutput', OutputName: o.name })

/** Plain text, no variables. */
const text = (s: string): P => ({ Value: { string: s }, WFSerializationType: 'WFTextTokenString' })

/** Text mixing literal strings and action outputs. */
function textOf(parts: Array<string | Output>): P {
  let str = ''
  const attachmentsByRange: { [k: string]: P } = {}
  for (const part of parts) {
    if (typeof part === 'string') {
      str += part
    } else {
      attachmentsByRange[`{${str.length}, 1}`] = ref(part)
      str += OBJ
    }
  }
  return { Value: { string: str, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' }
}

/** A whole variable as an action input. */
const attach = (o: Output): P => ({ Value: ref(o), WFSerializationType: 'WFTextTokenAttachment' })

/** An If's input: a variable. */
const ifInput = (o: Output): P => ({ Type: 'Variable', Variable: attach(o) })

/** A dictionary field (headers, JSON body): text keys, text values. */
function dict(entries: Array<{ key: string; value: P }>): P {
  return {
    Value: {
      WFDictionaryFieldValueItems: entries.map((e) => ({
        WFItemType: 0,
        WFKey: text(e.key),
        WFValue: e.value,
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  }
}

const action = (id: string, params: { [k: string]: P }): P => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${id}`,
  WFWorkflowActionParameters: params,
})

// Stable ids: magic-variable references point at these.
const id = (n: number) => `1D1D1D1D-0000-4000-8000-${String(n).padStart(12, '0')}`
const out = (n: number, name: string): Output => ({ uuid: id(n), name })

const SAVED_ID = out(1, 'File')
const ID_FROM_FILE = out(2, 'Text')
const RAND = [1, 2, 3, 4].map((k) => out(2 + k, 'Random Number'))
const NOW = out(7, 'Date')
const SEED = out(8, 'Text')
const NEW_ID = out(9, 'Hash')
const NEW_ID_FILE = out(10, 'Renamed Item')
const NEW_ID_TEXT = out(11, 'Text')
const DEVICE_ID = out(12, 'If Result')
const DEVICE_NAME = out(13, 'Device Name')
const DEVICE_MODEL = out(14, 'Device Model')
const NAME_ENCODED = out(15, 'URL Encoded Text')
const START = out(20, 'Date')
const AUDIO = out(21, 'Recorded Audio')
const ELAPSED = out(22, 'Time Between Dates')
const TYPED = out(23, 'Provided Input')
const RESPONSE = out(24, 'If Result')
const MESSAGE = out(25, 'Dictionary Value')
const HAVE_ID = id(100)
const BRANCH = id(101)
const CHECK = id(102)

// Shortcuts' WFCondition codes.
const IS_BETWEEN = 1003
const HAS_ANY_VALUE = 100

const capture = (body: { [k: string]: P }): P =>
  action('downloadurl', {
    WFURL: text(`${BASE_URL}/api/capture`),
    WFHTTPMethod: 'POST',
    ShowHeaders: true,
    WFHTTPHeaders: dict([
      { key: 'X-Idj-Device-Id', value: textOf([DEVICE_ID]) },
      { key: 'X-Idj-Device-Name', value: textOf([NAME_ENCODED]) },
      { key: 'X-Idj-Device-Model', value: textOf([DEVICE_MODEL]) },
    ]),
    ...body,
  })

const actions: P[] = [
  // --- this phone's device ID: read it, or make one and save it ------------
  action('documentpicker.open', {
    UUID: SAVED_ID.uuid,
    WFGetFilePath: text('idj/device-id.txt'),
    WFFileErrorIfNotFound: false,
    WFShowFilePicker: false,
  }),
  action('conditional', {
    GroupingIdentifier: HAVE_ID,
    WFControlFlowMode: 0,
    WFInput: ifInput(SAVED_ID),
    WFCondition: HAS_ANY_VALUE,
  }),
  action('gettext', { UUID: ID_FROM_FILE.uuid, WFTextActionText: textOf([SAVED_ID]) }),
  action('conditional', { GroupingIdentifier: HAVE_ID, WFControlFlowMode: 1 }),
  ...RAND.map((r) =>
    action('number.random', {
      UUID: r.uuid,
      WFRandomNumberMinimum: 0,
      WFRandomNumberMaximum: 999999999,
    }),
  ),
  action('date', { UUID: NOW.uuid, WFDateActionMode: 'Current Date' }),
  action('gettext', {
    UUID: SEED.uuid,
    WFTextActionText: textOf([RAND[0], '-', RAND[1], '-', RAND[2], '-', RAND[3], '-', NOW]),
  }),
  action('hash', { UUID: NEW_ID.uuid, WFInput: attach(SEED), WFHashType: 'SHA256' }),
  action('setitemname', {
    UUID: NEW_ID_FILE.uuid,
    WFInput: attach(NEW_ID),
    WFName: text('device-id.txt'),
  }),
  action('documentpicker.save', {
    WFInput: attach(NEW_ID_FILE),
    WFAskWhereToSave: false,
    WFFileDestinationPath: 'idj/',
    WFSaveFileOverwrite: true,
  }),
  action('gettext', { UUID: NEW_ID_TEXT.uuid, WFTextActionText: textOf([NEW_ID]) }),
  action('conditional', { GroupingIdentifier: HAVE_ID, WFControlFlowMode: 2, UUID: DEVICE_ID.uuid }),

  // --- who's capturing ------------------------------------------------------
  action('getdevicedetails', { UUID: DEVICE_NAME.uuid, WFDeviceDetail: 'Device Name' }),
  action('getdevicedetails', { UUID: DEVICE_MODEL.uuid, WFDeviceDetail: 'Device Model' }),
  action('urlencode', {
    UUID: NAME_ENCODED.uuid,
    WFInput: attach(DEVICE_NAME),
    WFEncodeMode: 'Encode',
  }),

  // --- capture --------------------------------------------------------------
  action('date', { UUID: START.uuid, WFDateActionMode: 'Current Date' }),
  action('recordaudio', {
    UUID: AUDIO.uuid,
    WFRecordingCompression: 'Normal',
    WFRecordingStart: 'Immediately',
    WFRecordingEnd: 'On Tap',
  }),
  // How long the recorder was open. Its sign depends on Shortcuts' argument
  // order, so the check is "between -N and N", which holds either way.
  action('gettimebetweendates', {
    UUID: ELAPSED.uuid,
    WFInput: attach(START),
    WFTimeUntilUnit: 'Seconds',
  }),
  action('conditional', {
    GroupingIdentifier: BRANCH,
    WFControlFlowMode: 0,
    WFInput: ifInput(ELAPSED),
    WFCondition: IS_BETWEEN,
    WFNumberValue: -TYPE_INSTEAD_SECONDS,
    WFAnotherNumber: TYPE_INSTEAD_SECONDS,
  }),
  // stopped almost at once: type instead, sent as JSON {text}
  action('ask', { UUID: TYPED.uuid, WFAskActionPrompt: 'Note for idj', WFInputType: 'Text' }),
  capture({
    WFHTTPBodyType: 'JSON',
    WFJSONValues: dict([{ key: 'text', value: textOf([TYPED]) }]),
  }),
  action('conditional', { GroupingIdentifier: BRANCH, WFControlFlowMode: 1 }),
  // keep a copy first (a dead network can't lose it), then upload the file
  action('documentpicker.save', {
    WFInput: attach(AUDIO),
    WFAskWhereToSave: false,
    WFFileDestinationPath: 'idj/',
    WFSaveFileOverwrite: false,
  }),
  capture({ WFHTTPBodyType: 'File', WFRequestVariable: attach(AUDIO) }),
  action('conditional', { GroupingIdentifier: BRANCH, WFControlFlowMode: 2, UUID: RESPONSE.uuid }),

  // --- tell the person what happened ----------------------------------------
  // Every idj answer carries `message`; anything else (a proxy's error page)
  // is shown whole.
  action('getvalueforkey', {
    UUID: MESSAGE.uuid,
    WFInput: attach(RESPONSE),
    WFGetDictionaryValueType: 'Value',
    WFDictionaryKey: text('message'),
  }),
  action('conditional', {
    GroupingIdentifier: CHECK,
    WFControlFlowMode: 0,
    WFInput: ifInput(MESSAGE),
    WFCondition: HAS_ANY_VALUE,
  }),
  action('notification', {
    WFNotificationActionBody: textOf([MESSAGE]),
    WFNotificationActionSound: false,
  }),
  action('conditional', { GroupingIdentifier: CHECK, WFControlFlowMode: 1 }),
  action('showresult', { Text: textOf([RESPONSE]) }),
  action('conditional', { GroupingIdentifier: CHECK, WFControlFlowMode: 2 }),
]

const shortcut: P = {
  WFWorkflowClientVersion: '2607.0.2',
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowMinimumClientVersionString: '900',
  WFWorkflowHasOutputFallback: false,
  WFWorkflowHasShortcutInputVariables: false,
  WFWorkflowIcon: {
    WFWorkflowIconStartColor: 4292093695, // amber, matches the app icon
    WFWorkflowIconGlyphNumber: 59511, // microphone
  },
  WFWorkflowImportQuestions: [],
  WFWorkflowInputContentItemClasses: [],
  WFWorkflowOutputContentItemClasses: [],
  WFQuickActionSurfaces: [],
  WFWorkflowTypes: [],
  WFWorkflowActions: actions,
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plist(shortcut, 0)}
</plist>
`

mkdirSync(OUT.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true })
writeFileSync(OUT, xml, 'utf8')
console.log(`wrote ${OUT} (${xml.length} bytes), base url ${BASE_URL}`)
