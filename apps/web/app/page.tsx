// Web shell entry (spec 220 step 8): the shared board app. The page module
// physically lives in the desktop shell until spec 221 hoists the shared
// shell surface into packages; its "@/lib" and "@/hooks" imports resolve
// through THIS app's tsconfig aliases (see ../lib/platform.ts), so the
// bundle it produces here is Tauri-free.
export { default } from "../../desktop/app/page"
