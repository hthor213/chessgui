import { describe, it, expect } from "vitest"
import { addDbPath, dbDisplayName, loadDbPaths } from "@/lib/db-registry"

describe("multi-DB registry (spec 200)", () => {
  it("adds to the front and dedupes", () => {
    expect(addDbPath([], "/a.db")).toEqual(["/a.db"])
    expect(addDbPath(["/a.db"], "/b.db")).toEqual(["/b.db", "/a.db"])
    expect(addDbPath(["/b.db", "/a.db"], "/a.db")).toEqual(["/a.db", "/b.db"])
  })

  it("caps the list", () => {
    let list: string[] = []
    for (let i = 0; i < 20; i++) list = addDbPath(list, `/db${i}.db`)
    expect(list.length).toBe(12)
    expect(list[0]).toBe("/db19.db")
  })

  it("displays the default and file basenames", () => {
    expect(dbDisplayName(undefined)).toBe("Default")
    expect(dbDisplayName("/Users/x/bases/mega2024.db")).toBe("mega2024.db")
  })

  it("load is safe without localStorage (node env)", () => {
    expect(loadDbPaths()).toEqual([])
  })
})
