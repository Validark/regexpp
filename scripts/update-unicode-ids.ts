import fs from "fs"
import http from "http"
import { CLIEngine } from "eslint"

const DB_URL = "http://unicode.org/Public/UNIDATA/DerivedCoreProperties.txt"
const FILE_PATH = "src/unicode/ids.ts"
const ID_START = /^([0-9a-z]+)(?:\.\.([0-9a-z]+))?[^;]*; ID_Start /iu
const ID_CONTINUE = /^([0-9a-z]+)(?:\.\.([0-9a-z]+))?[^;]*; ID_Continue /iu
const BORDER = 0x7f
const logger = console

    // Main
;(async () => {
    let banner = ""
    const idStartSet: Set<string> = new Set()
    const idStartSmall: [number, number][] = []
    const idStartLarge: [number, number][] = []
    const idContinueSmall: [number, number][] = []
    const idContinueLarge: [number, number][] = []

    logger.log("Fetching data... (%s)", DB_URL)
    await processEachLine(line => {
        let m: RegExpExecArray | null = null
        if (banner === "") {
            logger.log("Processing data... (%s)", line.slice(2))
            banner = `/* Generated from ${line.slice(2)} */`
        } else if ((m = ID_START.exec(line)) != null) {
            const min = parseInt(m[1], 16)
            const max = m[2] ? parseInt(m[2], 16) : min
            if (max <= BORDER) {
                idStartSmall.push([min, max])
            } else {
                idStartSet.add(`${min}..${max}`)
                idStartLarge.push([min, max])
            }
        } else if ((m = ID_CONTINUE.exec(line)) != null) {
            const min = parseInt(m[1], 16)
            const max = m[2] ? parseInt(m[2], 16) : min
            if (max <= BORDER) {
                idContinueSmall.push([min, max])
            } else if (!idStartSet.has(`${min}..${max}`)) {
                idContinueLarge.push([min, max])
            }
        }
    })

    logger.log("Normalizing data...")
    normalizeRanges(idStartSmall)
    normalizeRanges(idStartLarge)
    normalizeRanges(idContinueSmall)
    normalizeRanges(idContinueLarge)

    logger.log("Generating code...")
    let code = `${banner}

let largeIdStartPattern: RegExp | null = null;
let largeIdContinuePattern: RegExp | null = null;

export function isIdStart(cp: number): boolean {
    ${makeSmallCondtion(idStartSmall)}
    return isLargeIdStart(cp)
}
export function isIdContinue(cp: number): boolean {
    ${makeSmallCondtion(idContinueSmall)}
    return isLargeIdStart(cp) || isLargeIdContinue(cp)
}
function isLargeIdStart(cp: number): boolean {
    if (!largeIdStartPattern) {
        largeIdStartPattern = new RegExp(${makeLargePattern(idStartLarge)}, "u")
    }
    return largeIdStartPattern.test(String.fromCodePoint(cp))
}
function isLargeIdContinue(cp: number): boolean {
    if (!largeIdContinuePattern) {
        largeIdContinuePattern = new RegExp(${makeLargePattern(
            idContinueLarge,
        )}, "u")
    }
    return largeIdContinuePattern.test(String.fromCodePoint(cp))
}`

    logger.log("Formatting code...")
    const engine = new CLIEngine({
        fix: true,
        rules: { curly: "off" },
    })
    const result = engine.executeOnText(code, "ids.ts").results[0]
    code = result.output || code

    logger.log("Writing '%s'...", FILE_PATH)
    await save(code)

    logger.log("Completed!")
})().catch(error => {
    logger.error(error.stack)
    process.exitCode = 1
})

function processEachLine(cb: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        http.get(DB_URL, res => {
            let buffer = ""
            res.setEncoding("utf8")
            res.on("data", chunk => {
                const lines = (buffer + String(chunk)).split("\n")
                if (lines.length === 1) {
                    buffer = lines[0]
                } else {
                    buffer = lines.pop()!
                    for (const line of lines) {
                        cb(line)
                    }
                }
            })
            res.on("end", () => {
                if (buffer) {
                    cb(buffer)
                }
                resolve()
            })
            res.on("error", reject)
        }).on("error", reject)
    })
}

function normalizeRanges(ranges: [number, number][]): void {
    for (let i = ranges.length - 1; i >= 1; --i) {
        const currRange = ranges[i]
        const prevRange = ranges[i - 1]
        if (currRange[0] - 1 === prevRange[1]) {
            prevRange[1] = currRange[1]
            ranges.splice(i, 1)
        }
    }
}

function makeSmallCondtion(ranges: [number, number][]): string {
    const conditions: string[] = []
    for (const [min, max] of ranges) {
        if (min === max) {
            conditions.push(`if (cp === 0x${min.toString(16)}) return true`)
        } else {
            conditions.push(`if (cp < 0x${min.toString(16)}) return false`)
            conditions.push(`if (cp < 0x${(max + 1).toString(16)}) return true`)
        }
    }
    return conditions.join("\n")
}

function makeLargePattern(ranges: [number, number][]): string {
    const lines = ["^["]
    for (const [min, max] of ranges) {
        const line = lines[lines.length - 1]
        const part =
            min === max
                ? esc(min)
                : min + 1 === max
                ? `${esc(min)}${esc(max)}`
                : `${esc(min)}-${esc(max)}`

        if (line.length + part.length > 60) {
            lines.push(part)
        } else {
            lines[lines.length - 1] += part
        }
    }
    lines[lines.length - 1] += "]$"
    return lines.map(line => `"${line}"`).join("+")
}

function esc(cp: number): string {
    if (cp <= 0xff) {
        return `\\x${cp.toString(16).padStart(2, "0")}`
    }
    if (cp <= 0xffff) {
        return `\\u${cp.toString(16).padStart(4, "0")}`
    }
    return `\\u{${cp.toString(16)}}`
}

function save(content: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.writeFile(FILE_PATH, content, error =>
            error ? reject(error) : resolve(),
        )
    })
}
