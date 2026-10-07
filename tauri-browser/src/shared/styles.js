// Kessel's UI styles -- Liquid Glass, Hyper Clean, Futuristic, Robust and
// Vintage -- and the long list of options every one of them can be tuned
// with (Settings -> Appearance).
//
// A style is a set of defaults for OPTIONS plus a dark and a light palette.
// Your changes are kept per style in settings.ui_custom[style], holding only
// the values that differ from that style's defaults, so switching styles and
// back keeps them. Colours are kept per mode ("bg@dark", "bg@light").
//
// Everything ends up as CSS custom properties, data-k-* attributes and k-*
// classes on <html>, read by theme.css, styles.css, glass.css and each page's
// own CSS -- so every Kessel page (toolbar, new tab, settings, menus...)
// follows the same look. Nothing here runs continuously: effects that move
// (ambient drift, pulsing, the animated focus border) are opt-in.

export const STYLE_IDS = ["glass", "clean", "futuristic", "robust", "vintage", "gamer", "fluent", "soft", "terminal", "aqua", "brutal"];

// --- Fonts ---------------------------------------------------------------------
// Windows ships every one of these (Inter only if you installed it), so the
// look never depends on the network.

export const FONTS = [
  ["system", "System (Segoe UI Variable)", `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`],
  ["segoe", "Segoe UI", `"Segoe UI", system-ui, sans-serif`],
  ["inter", "Inter", `Inter, "Segoe UI Variable Text", "Segoe UI", sans-serif`],
  ["bahnschrift", "Bahnschrift", `Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif`],
  ["helvetica", "Helvetica / Arial", `"Helvetica Neue", Helvetica, Arial, sans-serif`],
  ["verdana", "Verdana", `Verdana, Geneva, sans-serif`],
  ["tahoma", "Tahoma", `Tahoma, Verdana, sans-serif`],
  ["trebuchet", "Trebuchet MS", `"Trebuchet MS", "Segoe UI", sans-serif`],
  ["calibri", "Calibri", `Calibri, Carlito, sans-serif`],
  ["candara", "Candara", `Candara, Calibri, sans-serif`],
  ["corbel", "Corbel", `Corbel, "Segoe UI", sans-serif`],
  ["century", "Century Gothic", `"Century Gothic", Futura, "Segoe UI", sans-serif`],
  ["franklin", "Franklin Gothic", `"Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif`],
  ["arialblack", "Arial Black", `"Arial Black", Arial, sans-serif`],
  ["impact", "Impact", `Impact, "Arial Black", sans-serif`],
  ["georgia", "Georgia", `Georgia, Cambria, serif`],
  ["cambria", "Cambria", `Cambria, Georgia, serif`],
  ["constantia", "Constantia", `Constantia, Georgia, serif`],
  ["palatino", "Palatino Linotype", `"Palatino Linotype", "Book Antiqua", Palatino, serif`],
  ["bookantiqua", "Book Antiqua", `"Book Antiqua", "Palatino Linotype", serif`],
  ["garamond", "Garamond", `Garamond, "EB Garamond", "Palatino Linotype", serif`],
  ["times", "Times New Roman", `"Times New Roman", Times, serif`],
  ["bookman", "Bookman Old Style", `"Bookman Old Style", Georgia, serif`],
  ["cascadia", "Cascadia Code", `"Cascadia Code", "Cascadia Mono", Consolas, monospace`],
  ["consolas", "Consolas", `Consolas, "Cascadia Mono", monospace`],
  ["courier", "Courier New (typewriter)", `"Courier New", Courier, monospace`],
  ["lucida", "Lucida Console", `"Lucida Console", Consolas, monospace`],
  ["segoeprint", "Segoe Print", `"Segoe Print", "Segoe UI", cursive`],
  ["segoescript", "Segoe Script", `"Segoe Script", "Segoe Print", cursive`],
  ["inkfree", "Ink Free", `"Ink Free", "Segoe Print", cursive`],
  ["gabriola", "Gabriola", `Gabriola, Georgia, serif`],
  ["comic", "Comic Sans MS", `"Comic Sans MS", "Segoe Print", cursive`],
  ["custom", "Your own font…", null],
];
const FONT_STACKS = Object.fromEntries(FONTS.map(([id, , stack]) => [id, stack]));

export function fontStack(id, custom) {
  if (id === "custom") {
    const name = String(custom || "").replace(/["\\;{}<>]/g, "").trim();
    return name ? `"${name}", ${FONT_STACKS.system}` : FONT_STACKS.system;
  }
  return FONT_STACKS[id] || FONT_STACKS.system;
}

// --- Option groups ---------------------------------------------------------------

export const GROUPS = [
  { id: "colour", title: "Colour & mode", icon: "palette", desc: "Dark or light, and the colours that give the style its character" },
  { id: "palette", title: "Palette", icon: "layers", desc: "Every colour of the interface, for the mode you're in now" },
  { id: "type", title: "Typography", icon: "edit", desc: "Fonts, sizes, weights and letter shapes" },
  { id: "shape", title: "Shape & borders", icon: "grid", desc: "How round, how sharp, how framed" },
  { id: "tabs", title: "Tabs", icon: "tabs", desc: "The shape and behaviour of every tab" },
  { id: "toolbar", title: "Toolbar & address bar", icon: "globe", desc: "Sizes, buttons, the address bar and the window's edge" },
  { id: "rail", title: "Side rail", icon: "sidebar", desc: "The column of pinned sites and tools on the left" },
  { id: "background", title: "Background", icon: "window", desc: "What's behind the toolbar and the new tab page" },
  { id: "depth", title: "Depth, light & shadow", icon: "sun", desc: "Shadows, glow, bevels and how things react to you" },
  { id: "glass", title: "Glass material", icon: "snowflake", desc: "The Liquid Glass itself", only: ["glass"] },
  { id: "texture", title: "Texture & atmosphere", icon: "activity", desc: "Grain, scanlines, vignette and site-icon filters" },
  { id: "flair", title: "Flourishes", icon: "bolt", desc: "Signature touches -- mix them across styles" },
  { id: "motion", title: "Motion", icon: "refresh", desc: "Speed and feel of every animation" },
  { id: "newtab", title: "New tab page", icon: "home", desc: "Clock, search box and speed dial" },
  { id: "scroll", title: "Scrollbars", icon: "ruler", desc: "Width, shape and colour" },
  { id: "css", title: "Your own CSS", icon: "code", desc: "For anything the options don't reach" },
];

// --- Options ---------------------------------------------------------------------
// def = the base value, used when a style doesn't set its own. showIf hides an
// option that only matters with another one's value (still kept if set).

const CASES = [["asis", "As designed"], ["none", "As written"], ["uppercase", "UPPERCASE"], ["smallcaps", "Small caps"], ["lowercase", "lowercase"], ["capitalize", "Title Case"]];

export const OPTIONS = [
  // Colour & mode
  { key: "mode", group: "colour", label: "Mode", type: "choice", choices: [["dark", "Dark"], ["light", "Light"], ["system", "Follow Windows"]], def: "dark" },
  { key: "accent", group: "colour", label: "Accent colour", desc: "Buttons, highlights, the active tab", type: "color", def: "#7c5cff" },
  { key: "accent2", group: "colour", label: "Second accent", desc: "The other end of gradients, glows and stripes", type: "color", def: "#6bd2ff" },
  { key: "accentGradient", group: "colour", label: "Gradient accents", desc: "Blend the two accents wherever the accent fills something", type: "toggle", def: false },
  { key: "gradientAngle", group: "colour", label: "Gradient angle", type: "range", min: 0, max: 360, step: 5, unit: "°", def: 135, showIf: (v) => v.accentGradient },
  { key: "accentText", group: "colour", label: "Text on the accent", type: "choice", choices: [["auto", "Automatic"], ["light", "Light"], ["dark", "Dark"]], def: "auto" },
  { key: "surfaceTint", group: "colour", label: "Tint surfaces with the accent", type: "range", min: 0, max: 40, step: 1, unit: "%", def: 0 },
  { key: "textContrast", group: "colour", label: "Secondary text strength", desc: "Pull dim and faint text toward full strength", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 0 },

  // Palette (per mode)
  { key: "bg", group: "palette", label: "Background", type: "color", perMode: true },
  { key: "surface", group: "palette", label: "Surfaces", desc: "Cards, panels, menus", type: "color", perMode: true },
  { key: "surface2", group: "palette", label: "Raised surfaces", desc: "Fields, chips, inner panels", type: "color", perMode: true },
  { key: "hover", group: "palette", label: "Hover", type: "color", perMode: true },
  { key: "border", group: "palette", label: "Borders", type: "color", perMode: true },
  { key: "text", group: "palette", label: "Text", type: "color", perMode: true },
  { key: "textDim", group: "palette", label: "Secondary text", type: "color", perMode: true },
  { key: "textFaint", group: "palette", label: "Faint text", type: "color", perMode: true },
  { key: "chromeBg", group: "palette", label: "Toolbar", type: "color", perMode: true },
  { key: "railBg", group: "palette", label: "Side rail", type: "color", perMode: true },
  { key: "tabActiveBg", group: "palette", label: "Active tab", type: "color", perMode: true },
  { key: "addressBg", group: "palette", label: "Address bar", type: "color", perMode: true },
  { key: "selection", group: "palette", label: "Text selection", type: "color", perMode: true },
  { key: "link", group: "palette", label: "Links", type: "color", perMode: true },
  { key: "danger", group: "palette", label: "Danger", type: "color", perMode: true },
  { key: "success", group: "palette", label: "Success & secure", type: "color", perMode: true },
  { key: "warning", group: "palette", label: "Warning & starred", type: "color", perMode: true },

  // Typography
  { key: "font", group: "type", label: "Interface font", type: "font", def: "system" },
  { key: "fontCustom", group: "type", label: "Your font's name", desc: "Exactly as Windows lists it, e.g. JetBrains Mono", type: "text", def: "", showIf: (v) => v.font === "custom" || v.addressFont === "custom" },
  { key: "fontSize", group: "type", label: "Text size", desc: "On top of Interface size below", type: "range", min: 11, max: 17, step: 0.5, unit: "px", def: 13.5 },
  { key: "fontWeight", group: "type", label: "Text weight", type: "range", min: 300, max: 700, step: 50, def: 400 },
  { key: "headingWeight", group: "type", label: "Heading weight", type: "range", min: 300, max: 900, step: 50, def: 650 },
  { key: "letterSpacing", group: "type", label: "Letter spacing", type: "range", min: -0.04, max: 0.2, step: 0.005, unit: "em", def: 0 },
  { key: "fontStretch", group: "type", label: "Letter width", desc: "For fonts that have widths, like Bahnschrift", type: "range", min: 62, max: 100, step: 1, unit: "%", def: 100 },
  { key: "labelCase", group: "type", label: "Labels & headings", type: "choice", choices: CASES, def: "asis" },
  { key: "tabTextCase", group: "type", label: "Tab titles", type: "choice", choices: CASES, def: "asis" },
  { key: "tabFontSize", group: "type", label: "Tab title size", type: "range", min: 10, max: 15, step: 0.5, unit: "px", def: 12 },
  { key: "addressFont", group: "type", label: "Address bar font", type: "font", withSame: true, def: "same" },
  { key: "addressFontSize", group: "type", label: "Address bar text size", type: "range", min: 11, max: 18, step: 0.5, unit: "px", def: 13 },
  { key: "textGlow", group: "type", label: "Neon text glow", desc: "Toolbar text glows in the glow colour", type: "range", min: 0, max: 20, step: 1, unit: "px", def: 0 },

  // Shape & borders
  { key: "radius", group: "shape", label: "Corner roundness", desc: "Buttons, fields and cards everywhere", type: "range", min: 0, max: 24, step: 1, unit: "px", def: 12 },
  { key: "panelRadius", group: "shape", label: "Panels, menus & popups", type: "range", min: 0, max: 32, step: 1, unit: "px", def: 14 },
  { key: "buttonRadius", group: "shape", label: "Toolbar buttons", type: "range", min: 0, max: 20, step: 1, unit: "px", def: 9 },
  { key: "borderWidth", group: "shape", label: "Border width", type: "range", min: 0, max: 4, step: 0.5, unit: "px", def: 1 },
  { key: "borderStyle", group: "shape", label: "Border style", type: "choice", choices: [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"], ["groove", "Groove"], ["ridge", "Ridge"], ["inset", "Inset"], ["outset", "Outset"]], def: "solid" },
  { key: "cornerCut", group: "shape", label: "Corner cut", desc: "How deep cut-corner (chamfer) shapes are cut", type: "range", min: 2, max: 16, step: 1, unit: "px", def: 8 },
  { key: "iconShape", group: "shape", label: "Site icon shape", type: "choice", choices: [["squircle", "Squircle"], ["circle", "Circle"], ["rounded", "Rounded"], ["square", "Square"], ["chamfer", "Cut corners"], ["hexagon", "Hexagon"]], def: "squircle" },

  // Tabs
  { key: "tabShape", group: "tabs", label: "Tab shape", type: "choice", choices: [["folder", "Folder"], ["rounded", "Rounded"], ["pill", "Pill"], ["square", "Square"], ["slanted", "Slanted"], ["chamfer", "Cut corners"], ["underline", "Just a line"]], def: "folder" },
  { key: "tabRadius", group: "tabs", label: "Tab roundness", type: "range", min: 0, max: 20, step: 1, unit: "px", def: 9, showIf: (v) => ["folder", "rounded", "slanted"].includes(v.tabShape) },
  { key: "tabHeight", group: "tabs", label: "Tab height", type: "range", min: 22, max: 44, step: 1, unit: "px", def: 33 },
  { key: "tabWidth", group: "tabs", label: "Tab width", type: "range", min: 100, max: 320, step: 5, unit: "px", def: 200 },
  { key: "tabGap", group: "tabs", label: "Space between tabs", type: "range", min: 0, max: 16, step: 1, unit: "px", def: 3 },
  { key: "tabPadding", group: "tabs", label: "Tab padding", type: "range", min: 2, max: 20, step: 1, unit: "px", def: 8 },
  { key: "tabIndicator", group: "tabs", label: "Active tab marker", type: "choice", choices: [["underline", "Underline"], ["overline", "Overline"], ["glow", "Glowing line"], ["side", "Side bar"], ["dot", "Dot"], ["none", "None"]], def: "underline" },
  { key: "indicatorThickness", group: "tabs", label: "Marker thickness", type: "range", min: 1, max: 6, step: 0.5, unit: "px", def: 2, showIf: (v) => v.tabIndicator !== "none" && v.tabIndicator !== "dot" },
  { key: "tabSeparators", group: "tabs", label: "Separators between tabs", type: "toggle", def: false },
  { key: "closeButton", group: "tabs", label: "Close buttons", type: "choice", choices: [["hover", "On hover"], ["always", "Always"], ["active", "Active tab"], ["never", "Never"]], def: "hover" },
  { key: "showFavicons", group: "tabs", label: "Site icons on tabs", type: "toggle", def: true },
  { key: "activeTabElevation", group: "tabs", label: "Active tab lift", desc: "A shadow that raises the active tab off the bar", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 0 },

  // Toolbar & address bar
  { key: "tabBarPad", group: "toolbar", label: "Space above the tabs", type: "range", min: 0, max: 16, step: 1, unit: "px", def: 7 },
  { key: "navHeight", group: "toolbar", label: "Toolbar height", type: "range", min: 34, max: 68, step: 1, unit: "px", def: 52 },
  { key: "buttonSize", group: "toolbar", label: "Button size", type: "range", min: 24, max: 42, step: 1, unit: "px", def: 32 },
  { key: "toolbarButtons", group: "toolbar", label: "Button look", type: "choice", choices: [["ghost", "Ghost"], ["raised", "Raised"], ["outline", "Outlined"], ["filled", "Filled"]], def: "ghost", notFor: ["glass"] },
  { key: "iconScale", group: "toolbar", label: "Icon size", type: "range", min: 0.7, max: 1.5, step: 0.05, unit: "×", def: 1 },
  { key: "iconStroke", group: "toolbar", label: "Icon line weight", desc: "Every line icon in Kessel", type: "range", min: 1, max: 3, step: 0.1, def: 1.8 },
  { key: "addressShape", group: "toolbar", label: "Address bar shape", type: "choice", choices: [["pill", "Pill"], ["rounded", "Rounded"], ["square", "Square"], ["chamfer", "Cut corners"], ["underline", "Just a line"]], def: "pill" },
  { key: "addressRadius", group: "toolbar", label: "Address bar roundness", type: "range", min: 0, max: 24, step: 1, unit: "px", def: 8, showIf: (v) => v.addressShape === "rounded" },
  { key: "addressHeight", group: "toolbar", label: "Address bar height", type: "range", min: 26, max: 48, step: 1, unit: "px", def: 34 },
  { key: "addressAlign", group: "toolbar", label: "Address text", type: "choice", choices: [["left", "Left"], ["center", "Centred"]], def: "left" },
  { key: "bookmarksHeight", group: "toolbar", label: "Bookmarks bar height", type: "range", min: 22, max: 40, step: 1, unit: "px", def: 30 },
  { key: "dividers", group: "toolbar", label: "Divider lines", desc: "Lines between the tab strip, toolbar and page", type: "toggle", def: true, notFor: ["glass"] },
  { key: "windowControls", group: "toolbar", label: "Window buttons", type: "choice", choices: [["windows", "Windows"], ["mac", "Traffic lights"], ["minimal", "Minimal"], ["outline", "Outlined"]], def: "windows" },
  { key: "stripeTop", group: "toolbar", label: "Top edge", desc: "A band along the very top of the window", type: "choice", choices: [["none", "None"], ["accent", "Accent"], ["gradient", "Gradient"], ["hazard", "Hazard stripes"], ["rainbow", "Rainbow"], ["rule", "Double rule"]], def: "none" },
  { key: "stripeHeight", group: "toolbar", label: "Top edge thickness", type: "range", min: 1, max: 8, step: 1, unit: "px", def: 3, showIf: (v) => v.stripeTop !== "none" },

  // Side rail
  { key: "railWidth", group: "rail", label: "Rail width", type: "range", min: 40, max: 84, step: 1, unit: "px", def: 52 },
  { key: "railIcon", group: "rail", label: "Icon size", type: "range", min: 26, max: 48, step: 1, unit: "px", def: 36 },
  { key: "railGap", group: "rail", label: "Space between icons", type: "range", min: 0, max: 16, step: 1, unit: "px", def: 6 },
  { key: "railFloating", group: "rail", label: "Floating capsule", desc: "The rail as a rounded capsule instead of a flush column", type: "toggle", def: false, notFor: ["glass"] },
  { key: "showRailLogo", group: "rail", label: "Kessel button", desc: "The new tab button at the top", type: "toggle", def: true },

  // Background
  { key: "background", group: "background", label: "Background", type: "choice", choices: [["solid", "Solid"], ["gradient", "Gradient"], ["wallpaper", "Wallpaper"], ["pattern", "Pattern"]], def: "solid" },
  { key: "wallpaper", group: "background", label: "Wallpaper", type: "wallpaper", def: "nightfall", showIf: (v) => v.background === "wallpaper" },
  { key: "bgGradientA", group: "background", label: "Gradient from", type: "color", def: "#1b1440", showIf: (v) => v.background === "gradient" },
  { key: "bgGradientB", group: "background", label: "Gradient to", type: "color", def: "#0b3a4a", showIf: (v) => v.background === "gradient" },
  { key: "bgGradientAngle", group: "background", label: "Gradient angle", type: "range", min: 0, max: 360, step: 5, unit: "°", def: 160, showIf: (v) => v.background === "gradient" },
  { key: "pattern", group: "background", label: "Pattern", type: "choice", choices: [["grid", "Grid"], ["dots", "Dots"], ["lines", "Lines"], ["diagonal", "Diagonal"], ["crosshatch", "Crosshatch"], ["checker", "Checker"], ["carbon", "Carbon fibre"], ["waves", "Scales"], ["circuit", "Circuit"], ["hazard", "Hazard"], ["linen", "Linen"]], def: "grid", showIf: (v) => v.background === "pattern" },
  { key: "patternSize", group: "background", label: "Pattern size", type: "range", min: 4, max: 80, step: 1, unit: "px", def: 24, showIf: (v) => v.background === "pattern" },
  { key: "patternOpacity", group: "background", label: "Pattern strength", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 12, showIf: (v) => v.background === "pattern" },
  { key: "patternColor", group: "background", label: "Pattern colour", type: "choice", choices: [["text", "Text"], ["accent", "Accent"], ["accent2", "Second accent"], ["border", "Border"]], def: "text", showIf: (v) => v.background === "pattern" },
  { key: "chromeOpacity", group: "background", label: "Toolbar opacity", desc: "How much of the background shows through the bars", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 85, showIf: (v, id) => v.background !== "solid" && id !== "glass" },
  { key: "wallDim", group: "background", label: "Darken", type: "range", min: 0, max: 80, step: 1, unit: "%", def: 0, showIf: (v) => v.background !== "solid" },
  { key: "wallBlur", group: "background", label: "Blur", type: "range", min: 0, max: 40, step: 1, unit: "px", def: 0, showIf: (v) => v.background !== "solid" },
  { key: "wallSaturate", group: "background", label: "Colour intensity", type: "range", min: 0, max: 200, step: 5, unit: "%", def: 100, showIf: (v) => v.background !== "solid" },

  // Depth, light & shadow
  { key: "shadow", group: "depth", label: "Shadow strength", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 35 },
  { key: "shadowSoftness", group: "depth", label: "Shadow softness", desc: "0 = a crisp, retro offset shadow", type: "range", min: 0, max: 60, step: 1, unit: "px", def: 30 },
  { key: "shadowOffset", group: "depth", label: "Shadow distance", type: "range", min: 0, max: 20, step: 1, unit: "px", def: 8 },
  { key: "shadowColor", group: "depth", label: "Shadow colour", type: "color", def: "#000000" },
  { key: "cardShadows", group: "depth", label: "Shadows on cards & buttons", type: "toggle", def: false },
  { key: "glow", group: "depth", label: "Glow", desc: "Active and focused things glow", type: "range", min: 0, max: 40, step: 1, unit: "px", def: 0 },
  { key: "glowColor", group: "depth", label: "Glow colour", type: "choice", choices: [["accent", "Accent"], ["accent2", "Second accent"], ["text", "Text"], ["white", "White"]], def: "accent" },
  { key: "bevel", group: "depth", label: "Bevel", desc: "3D edges, like physical keys", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 0 },
  { key: "softShadows", group: "depth", label: "Soft 3D", desc: "Surfaces look pressed out of the background (neumorphism)", type: "toggle", def: false },
  { key: "gloss", group: "depth", label: "Gloss", desc: "A soft highlight across the top of things", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 0 },
  { key: "focusStyle", group: "depth", label: "Focus highlight", type: "choice", choices: [["ring", "Ring"], ["glow", "Glow"], ["outline", "Outline"], ["underline", "Underline"], ["none", "None"]], def: "ring" },
  { key: "hoverLift", group: "depth", label: "Lift on hover", type: "range", min: 0, max: 6, step: 0.5, unit: "px", def: 0 },
  { key: "pressScale", group: "depth", label: "Press depth", desc: "How far buttons sink when clicked", type: "range", min: 0, max: 15, step: 1, unit: "%", def: 4 },

  // Glass material
  { key: "glassBlur", group: "glass", label: "Frost", desc: "How much the glass blurs what's behind it", type: "range", min: 0, max: 40, step: 1, unit: "px", def: 14 },
  { key: "glassSaturation", group: "glass", label: "Colour boost", type: "range", min: 100, max: 300, step: 10, unit: "%", def: 180 },
  { key: "glassTint", group: "glass", label: "Tint amount", type: "range", min: 0, max: 300, step: 10, unit: "%", def: 100 },
  { key: "glassTintColor", group: "glass", label: "Tint colour", type: "color", def: "#ffffff" },
  { key: "glassRim", group: "glass", label: "Edge light", desc: "The bright rim where light catches the glass", type: "range", min: 0, max: 200, step: 10, unit: "%", def: 100 },
  { key: "glassGloss", group: "glass", label: "Gloss", type: "range", min: 0, max: 200, step: 10, unit: "%", def: 100 },
  { key: "glassShadow", group: "glass", label: "Floating shadow", type: "range", min: 0, max: 200, step: 10, unit: "%", def: 100 },
  { key: "glassRefraction", group: "glass", label: "Refraction", desc: "Bend the background at the edges, like real glass", type: "toggle", def: true },
  { key: "refractionStrength", group: "glass", label: "Refraction strength", type: "range", min: 1, max: 30, step: 1, def: 9, showIf: (v) => v.glassRefraction },
  { key: "glassTone", group: "glass", label: "Text on glass", type: "choice", choices: [["auto", "From the wallpaper"], ["white", "White"], ["dark", "Dark"]], def: "auto" },

  // Texture & atmosphere
  { key: "grain", group: "texture", label: "Film grain", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 0 },
  { key: "vignette", group: "texture", label: "Vignette", desc: "Darkened edges", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 0 },
  { key: "scanlines", group: "texture", label: "Scanlines", type: "range", min: 0, max: 100, step: 1, unit: "%", def: 0 },
  { key: "scanlineSize", group: "texture", label: "Scanline spacing", type: "range", min: 2, max: 8, step: 1, unit: "px", def: 3, showIf: (v) => v.scanlines > 0 },
  { key: "iconFilter", group: "texture", label: "Site icon filter", type: "choice", choices: [["none", "None"], ["grayscale", "Greyscale"], ["sepia", "Sepia"], ["vivid", "Vivid"], ["faded", "Faded"], ["invert", "Inverted"]], def: "none" },
  { key: "iconFilterAmount", group: "texture", label: "Filter amount", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 100, showIf: (v) => v.iconFilter !== "none" },
  { key: "ambientMotion", group: "texture", label: "Drifting background", desc: "Gradients and patterns slowly move. Uses a little more power.", type: "toggle", def: false },

  // Flourishes
  { key: "neonBorders", group: "flair", label: "Neon borders", desc: "Borders take the accent colour and glow faintly", type: "toggle", def: false },
  { key: "hudBrackets", group: "flair", label: "HUD brackets", desc: "Corner brackets on the address bar, active tab and cards", type: "toggle", def: false },
  { key: "animatedBorder", group: "flair", label: "Animated focus border", desc: "A light that runs around the address bar while you type", type: "toggle", def: false },
  { key: "rivets", group: "flair", label: "Rivets", desc: "Bolted corners on panels and the rail", type: "toggle", def: false },
  { key: "ornaments", group: "flair", label: "Ornaments", desc: "Typographic flourishes around headings", type: "toggle", def: false },
  { key: "ornamentGlyph", group: "flair", label: "Ornament", type: "choice", choices: [["❦", "❦"], ["❧", "❧"], ["☙", "☙"], ["✦", "✦"], ["✧", "✧"], ["◆", "◆"], ["⁂", "⁂"], ["✺", "✺"]], def: "❦", showIf: (v) => v.ornaments },
  { key: "glitch", group: "flair", label: "Glitch on hover", desc: "Tab titles and bookmarks jitter in the accent colours", type: "toggle", def: false },
  { key: "pulse", group: "flair", label: "Pulsing highlights", desc: "The active tab marker and focus ring breathe", type: "toggle", def: false },

  // Motion
  { key: "animSpeed", group: "motion", label: "Animation speed", type: "range", min: 0.25, max: 3, step: 0.05, unit: "×", def: 1 },
  { key: "easing", group: "motion", label: "Feel", type: "choice", choices: [["smooth", "Smooth"], ["snappy", "Snappy"], ["bouncy", "Bouncy"], ["elastic", "Elastic"], ["sharp", "Sharp"], ["linear", "Linear"]], def: "smooth" },
  { key: "tabAnimation", group: "motion", label: "New tabs appear", type: "choice", choices: [["pop", "Pop"], ["fade", "Fade"], ["slide", "Slide"], ["drop", "Drop"], ["flip", "Flip"], ["none", "Instantly"]], def: "pop" },
  { key: "uiSounds", group: "motion", label: "Interface sounds", desc: "Clicks and blips as you switch, open, close and drag tabs", type: "choice", choices: [["none", "Off"], ["soft", "Soft"], ["click", "Clicks"], ["gx", "Gamer"], ["retro", "8-bit"], ["typewriter", "Typewriter"]], def: "none" },
  { key: "uiSoundVolume", group: "motion", label: "Sound volume", type: "range", min: 0, max: 100, step: 5, unit: "%", def: 50, showIf: (v) => v.uiSounds !== "none" },
  { key: "typingSounds", group: "motion", label: "Typing sounds", desc: "A sound for every key in the address bar", type: "toggle", def: false, showIf: (v) => v.uiSounds !== "none" },

  // New tab page
  { key: "ntClock", group: "newtab", label: "Clock", type: "toggle", def: true },
  { key: "clockFormat", group: "newtab", label: "Clock format", type: "choice", choices: [["24h", "24-hour"], ["12h", "12-hour"]], def: "24h", showIf: (v) => v.ntClock },
  { key: "clockSeconds", group: "newtab", label: "Seconds", type: "toggle", def: false, showIf: (v) => v.ntClock },
  { key: "clockSize", group: "newtab", label: "Clock size", type: "range", min: 32, max: 160, step: 2, unit: "px", def: 84, showIf: (v) => v.ntClock },
  { key: "clockWeight", group: "newtab", label: "Clock weight", type: "range", min: 100, max: 900, step: 50, def: 250, showIf: (v) => v.ntClock },
  { key: "ntDate", group: "newtab", label: "Date", type: "toggle", def: true },
  { key: "ntAlign", group: "newtab", label: "Position", type: "choice", choices: [["top", "Near the top"], ["center", "Centred"]], def: "top" },
  { key: "ntSearchWidth", group: "newtab", label: "Search box width", type: "range", min: 320, max: 900, step: 10, unit: "px", def: 600 },
  { key: "ntTileSize", group: "newtab", label: "Speed dial icon size", type: "range", min: 36, max: 88, step: 2, unit: "px", def: 60 },
  { key: "ntSpeedDial", group: "newtab", label: "Speed dial", type: "toggle", def: true },
  { key: "ntBookmarks", group: "newtab", label: "Bookmarks", type: "toggle", def: true },
  { key: "ntPanels", group: "newtab", label: "Section backgrounds", type: "choice", choices: [["panel", "Panels"], ["bare", "None"]], def: "panel" },

  // Scrollbars
  { key: "scrollbarWidth", group: "scroll", label: "Width", desc: "0 hides them (you can still scroll)", type: "range", min: 0, max: 16, step: 1, unit: "px", def: 10 },
  { key: "scrollbarShape", group: "scroll", label: "Shape", type: "choice", choices: [["round", "Round"], ["square", "Square"]], def: "round" },
  { key: "scrollbarColor", group: "scroll", label: "Colour", type: "choice", choices: [["auto", "Subtle"], ["accent", "Accent"], ["text", "Strong"]], def: "auto" },

  // Your own CSS
  { key: "customCss", group: "css", label: "Custom CSS", desc: "Added to every Kessel page: html[data-page=\"toolbar\"] is the toolbar, html[data-page=\"newtab\"] the new tab page.", type: "code", def: "" },
];

export const OPTION_MAP = Object.fromEntries(OPTIONS.map((o) => [o.key, o]));
const PALETTE_KEYS = OPTIONS.filter((o) => o.perMode).map((o) => o.key);

// --- Styles ----------------------------------------------------------------------
// A palette entry is a colour, "=key" (same as another, after your changes),
// or [a, b, percent] -- a mixed toward b. Missing entries use BASE_PALETTE.

const BASE_PALETTE = {
  surface2: ["surface", "text", 4],
  hover: ["surface", "text", 8],
  textDim: ["text", "bg", 38],
  textFaint: ["text", "bg", 62],
  chromeBg: "=bg",
  railBg: "=surface",
  tabActiveBg: "=surface",
  addressBg: "=surface",
  selection: "=accent",
  link: "=accent",
  danger: "#ff5c73",
  success: "#34d399",
  warning: "#ffb454",
};

export const STYLES = {
  glass: {
    name: "Liquid Glass",
    tagline: "Translucent capsules floating over a wallpaper",
    palette: {
      dark: { bg: "#0b0c10", surface: "#15161c", surface2: "#1b1d25", hover: "#22242e", border: "#262834", text: "#eceef4", textDim: "#9498a8", textFaint: "#5c6072" },
      light: { bg: "#f4f5f8", surface: "#ffffff", surface2: "#f0f1f5", hover: "#e8e9ee", border: "#e2e3ea", text: "#191a23", textDim: "#6b6e7d", textFaint: "#a4a7b3", danger: "#e5484d", success: "#16a34a", warning: "#d97706" },
    },
    defaults: {
      background: "wallpaper", wallpaper: "nightfall",
      tabShape: "pill", tabHeight: 32, tabBarPad: 8, tabGap: 4, tabWidth: 210, tabIndicator: "none", tabPadding: 8,
      navHeight: 46, buttonSize: 32, addressHeight: 36, addressShape: "pill", bookmarksHeight: 34,
      railWidth: 64, railIcon: 36, railGap: 8, buttonRadius: 15, panelRadius: 18,
      dividers: false, shadow: 28,
    },
    quick: ["wallpaper", "glassBlur", "glassTint", "glassTintColor", "glassRim", "glassRefraction", "accent", "tabShape"],
    presets: [
      { name: "Frost", values: {} },
      { name: "Crystal", values: { glassBlur: 4, glassRim: 180, glassGloss: 160, glassTint: 60, refractionStrength: 16 } },
      { name: "Smoked", values: { glassTintColor: "#000000", glassTint: 260, glassBlur: 22, wallpaper: "graphite", accent: "#9ea7b8", glassRim: 70 } },
      { name: "Rose Quartz", values: { glassTintColor: "#ffb3d1", glassTint: 170, wallpaper: "sunset", accent: "#ff5c9a", accent2: "#ffb86b" } },
      { name: "Arctic", values: { wallpaper: "daylight", mode: "light", accent: "#2f7bff", glassBlur: 20, glassTint: 120 } },
      { name: "Aurora Pills", values: { wallpaper: "aurora", accent: "#2ee6a6", accent2: "#8b5cff", accentGradient: true, tabIndicator: "dot", glow: 10 } },
    ],
  },

  clean: {
    name: "Hyper Clean",
    tagline: "Flat, quiet and precise -- nothing but the content",
    palette: {
      light: { bg: "#ffffff", surface: "#ffffff", surface2: "#f5f5f7", hover: "#efeff2", border: "#ebebef", text: "#0d0d10", textDim: "#62636b", textFaint: "#a3a4ac", chromeBg: "#ffffff", railBg: "#fafafb", tabActiveBg: "#f1f1f4", addressBg: "#f3f3f6", danger: "#e5484d", success: "#1f9d55", warning: "#c77700" },
      dark: { bg: "#0e0e10", surface: "#141416", surface2: "#1a1a1d", hover: "#202024", border: "#232327", text: "#f4f4f5", textDim: "#a1a1aa", textFaint: "#5d5d66", chromeBg: "#0e0e10", railBg: "#111113", tabActiveBg: "#1d1d21", addressBg: "#19191c" },
    },
    defaults: {
      mode: "light", accent: "#3d7bff", accent2: "#8e5cff",
      font: "system", fontWeight: 400, headingWeight: 600, letterSpacing: -0.005,
      radius: 8, panelRadius: 12, buttonRadius: 8, borderWidth: 1,
      tabShape: "rounded", tabRadius: 8, tabHeight: 30, tabBarPad: 8, tabGap: 4, tabIndicator: "none", tabPadding: 10,
      navHeight: 48, addressShape: "rounded", addressRadius: 10, addressHeight: 34,
      iconStroke: 1.6, dividers: true, shadow: 12, shadowSoftness: 24, shadowOffset: 6,
      railWidth: 52, railIcon: 34, pressScale: 2, easing: "smooth", tabAnimation: "fade",
      clockWeight: 200, ntPanels: "bare", scrollbarWidth: 8,
    },
    quick: ["mode", "accent", "font", "radius", "tabShape", "dividers", "fontSize", "iconStroke"],
    presets: [
      { name: "Paper", values: {} },
      { name: "Graphite", values: { mode: "dark" } },
      { name: "Nordic", values: { accent: "#5e81ac", font: "segoe", "bg@light": "#eceff4", "surface@light": "#f5f7fa", "chromeBg@light": "#e5e9f0", "railBg@light": "#e5e9f0", "tabActiveBg@light": "#f5f7fa", "addressBg@light": "#f5f7fa", "text@light": "#2e3440", "border@light": "#d8dee9" } },
      { name: "Mono", values: { mode: "light", accent: "#111111", accent2: "#555555", font: "helvetica", headingWeight: 700, tabIndicator: "underline", indicatorThickness: 2, radius: 0, tabShape: "square", addressShape: "square", buttonRadius: 0, panelRadius: 0 } },
      { name: "Sand", values: { accent: "#b5651d", "bg@light": "#faf7f2", "surface@light": "#fffdf9", "chromeBg@light": "#f5f0e8", "railBg@light": "#f5f0e8", "tabActiveBg@light": "#fffdf9", "addressBg@light": "#ffffff", "border@light": "#ebe3d6", "text@light": "#2b2622" } },
      { name: "Airy", values: { tabHeight: 34, navHeight: 58, addressHeight: 40, tabGap: 8, railWidth: 60, railIcon: 38, fontSize: 14, radius: 12, addressShape: "pill", tabShape: "pill" } },
    ],
  },

  futuristic: {
    name: "Futuristic",
    tagline: "Neon HUD -- cut corners, glow and a grid under everything",
    palette: {
      dark: { bg: "#05070d", surface: "#0a0f1a", surface2: "#0e1524", hover: "#13203a", border: "#12364a", text: "#d9fbff", textDim: "#7fb3c4", textFaint: "#3f6475", chromeBg: "#04060b", railBg: "#070b14", tabActiveBg: "#0b1a2a", addressBg: "#070d18", danger: "#ff3864", success: "#00ff9c", warning: "#ffd000" },
      light: { bg: "#e9f3f7", surface: "#f7fcfe", surface2: "#dcebf2", hover: "#cfe4ee", border: "#8fc3d6", text: "#04222e", textDim: "#2d6275", textFaint: "#6f98a8", chromeBg: "#e3f0f5", railBg: "#d9eaf1", tabActiveBg: "#ffffff", addressBg: "#f3fafd", danger: "#e0164a", success: "#00a86b", warning: "#b88a00" },
    },
    defaults: {
      mode: "dark", accent: "#00e5ff", accent2: "#ff2bd6", accentGradient: true, gradientAngle: 90,
      font: "bahnschrift", fontStretch: 88, letterSpacing: 0.04, labelCase: "uppercase", headingWeight: 600,
      radius: 2, panelRadius: 2, buttonRadius: 2, cornerCut: 8, iconShape: "chamfer",
      tabShape: "chamfer", tabHeight: 30, tabBarPad: 8, tabGap: 4, tabIndicator: "glow", indicatorThickness: 2,
      navHeight: 48, addressShape: "chamfer", addressHeight: 34, toolbarButtons: "outline", iconStroke: 1.5,
      textGlow: 6, glow: 12, shadow: 0, focusStyle: "glow",
      background: "pattern", pattern: "grid", patternSize: 32, patternOpacity: 10, patternColor: "accent", chromeOpacity: 88,
      scanlines: 10, scanlineSize: 3, vignette: 20,
      neonBorders: true, hudBrackets: true, animatedBorder: true,
      stripeTop: "gradient", stripeHeight: 2, windowControls: "outline",
      easing: "snappy", tabAnimation: "slide", clockWeight: 300, scrollbarWidth: 6, scrollbarShape: "square", scrollbarColor: "accent",
    },
    quick: ["accent", "accent2", "glow", "scanlines", "pattern", "hudBrackets", "cornerCut", "font"],
    presets: [
      { name: "Neon Grid", values: {} },
      { name: "Tron", values: { accent: "#00d9ff", accent2: "#00d9ff", patternSize: 48, patternOpacity: 18, glow: 18, scanlines: 0, "bg@dark": "#000000", "chromeBg@dark": "#000000", "railBg@dark": "#000000", fontStretch: 75 } },
      { name: "Blade Runner", values: { accent: "#ff8a00", accent2: "#00c2ff", "bg@dark": "#0b0806", "surface@dark": "#15100c", "surface2@dark": "#1d1510", "hover@dark": "#2a1d14", "border@dark": "#4a2b12", "text@dark": "#ffe8cf", "textDim@dark": "#c49a72", "textFaint@dark": "#6e5238", "chromeBg@dark": "#080604", "railBg@dark": "#0d0906", "tabActiveBg@dark": "#1f140c", "addressBg@dark": "#0d0906", pattern: "lines", patternSize: 6, vignette: 45, grain: 12 } },
      { name: "Matrix", values: { accent: "#00ff66", accent2: "#00aa44", font: "consolas", addressFont: "consolas", fontStretch: 100, "bg@dark": "#000800", "surface@dark": "#001a0a", "surface2@dark": "#002210", "hover@dark": "#003318", "border@dark": "#0b4d24", "text@dark": "#b6ffcf", "textDim@dark": "#4fcf7f", "textFaint@dark": "#1f6b3c", "chromeBg@dark": "#000500", "railBg@dark": "#000a03", "tabActiveBg@dark": "#002a12", "addressBg@dark": "#000a03", scanlines: 24, pattern: "circuit", patternSize: 40, textGlow: 8 } },
      { name: "Synthwave", values: { accent: "#ff2bd6", accent2: "#8a5cff", background: "gradient", bgGradientA: "#2b0a3d", bgGradientB: "#07051a", bgGradientAngle: 180, glow: 20, chromeOpacity: 70, stripeTop: "rainbow" } },
      { name: "Ice HUD", values: { mode: "light", accent: "#0091c2", accent2: "#7a5cff", scanlines: 0, vignette: 0, patternOpacity: 14, textGlow: 0, glow: 8 } },
    ],
  },

  robust: {
    name: "Robust",
    tagline: "Industrial and tactile -- thick frames, bevels and bolts",
    palette: {
      dark: { bg: "#16181b", surface: "#24272b", surface2: "#2d3136", hover: "#353a40", border: "#0b0c0e", text: "#eef0f2", textDim: "#a3a9b0", textFaint: "#6b7178", chromeBg: "#1c1f23", railBg: "#202327", tabActiveBg: "#2d3136", addressBg: "#121417", danger: "#ff4d3d", success: "#3ecf6e", warning: "#ffb020" },
      light: { bg: "#c9ced3", surface: "#e3e6e9", surface2: "#d6dade", hover: "#cdd2d7", border: "#6f777f", text: "#15181b", textDim: "#434a51", textFaint: "#6f777f", chromeBg: "#b9bfc5", railBg: "#aeb5bc", tabActiveBg: "#e3e6e9", addressBg: "#f2f4f5", danger: "#c8281b", success: "#1d8a45", warning: "#b86e00" },
    },
    defaults: {
      mode: "dark", accent: "#ffb000", accent2: "#ff6a00",
      font: "bahnschrift", fontWeight: 450, headingWeight: 700, letterSpacing: 0.02, labelCase: "uppercase",
      radius: 4, panelRadius: 6, buttonRadius: 4, borderWidth: 2, iconShape: "rounded",
      tabShape: "folder", tabRadius: 5, tabHeight: 34, tabBarPad: 8, tabGap: 3, tabIndicator: "overline", indicatorThickness: 3, activeTabElevation: 40,
      navHeight: 54, buttonSize: 34, toolbarButtons: "raised", addressShape: "rounded", addressRadius: 4, addressHeight: 34, iconStroke: 2.2,
      bevel: 70, gloss: 30, shadow: 60, shadowSoftness: 0, shadowOffset: 3, cardShadows: true, focusStyle: "outline", pressScale: 6,
      rivets: true, stripeTop: "hazard", stripeHeight: 4, grain: 8,
      background: "pattern", pattern: "diagonal", patternSize: 8, patternOpacity: 5, chromeOpacity: 96,
      railWidth: 56, easing: "sharp", tabAnimation: "drop", clockWeight: 700, scrollbarWidth: 12, scrollbarShape: "square",
    },
    quick: ["accent", "bevel", "borderWidth", "stripeTop", "rivets", "pattern", "shadowOffset", "font"],
    presets: [
      { name: "Workshop", values: {} },
      { name: "Military", values: { accent: "#c9b458", accent2: "#7a8450", "bg@dark": "#1d2118", "surface@dark": "#2b3024", "surface2@dark": "#353b2c", "hover@dark": "#3d4433", "border@dark": "#0e100b", "text@dark": "#e4e2cf", "chromeBg@dark": "#23271d", "railBg@dark": "#262b20", "tabActiveBg@dark": "#353b2c", "addressBg@dark": "#171a12", stripeTop: "accent", pattern: "crosshatch", fontStretch: 80, tabTextCase: "uppercase" } },
      { name: "Construction", values: { accent: "#ffcc00", accent2: "#111111", stripeTop: "hazard", stripeHeight: 6, pattern: "hazard", patternOpacity: 5, patternSize: 16, tabIndicator: "overline", indicatorThickness: 4 } },
      { name: "Steel", values: { mode: "light", accent: "#1f6feb", accent2: "#5b6b7c", stripeTop: "none", pattern: "lines", patternSize: 3, patternOpacity: 6, gloss: 60, shadow: 35 } },
      { name: "Rust Belt", values: { accent: "#d9622b", accent2: "#8c3b1a", "bg@dark": "#1c1411", "surface@dark": "#2a1f1a", "surface2@dark": "#342720", "hover@dark": "#3d2e26", "border@dark": "#0d0907", "text@dark": "#f1e4da", "chromeBg@dark": "#211813", "railBg@dark": "#251b16", "tabActiveBg@dark": "#342720", "addressBg@dark": "#140e0b", grain: 16, stripeTop: "accent" } },
      { name: "Carbon", values: { accent: "#e10600", accent2: "#ffffff", pattern: "carbon", patternOpacity: 60, patternSize: 6, bevel: 50, gloss: 50, stripeTop: "accent", rivets: false } },
    ],
  },

  vintage: {
    name: "Vintage",
    tagline: "Old paper, serif type, ink and a little dust",
    palette: {
      light: { bg: "#eadfc8", surface: "#f4ecd9", surface2: "#e6d9bd", hover: "#ddcdab", border: "#a8926a", text: "#3a2c1e", textDim: "#6b5741", textFaint: "#9c8768", chromeBg: "#e3d6ba", railBg: "#dccda9", tabActiveBg: "#f4ecd9", addressBg: "#f8f2e3", danger: "#a8322a", success: "#4f7a3a", warning: "#b7791f" },
      dark: { bg: "#1d1812", surface: "#28211a", surface2: "#322a21", hover: "#3b3228", border: "#5a4a36", text: "#eadcc0", textDim: "#b9a888", textFaint: "#7d6d55", chromeBg: "#1a150f", railBg: "#211b14", tabActiveBg: "#2e261d", addressBg: "#15110c", danger: "#d4574a", success: "#8fb573", warning: "#d9a441" },
    },
    defaults: {
      mode: "light", accent: "#8c2f23", accent2: "#2e5b4f",
      font: "palatino", headingWeight: 700, letterSpacing: 0.01, labelCase: "smallcaps", tabFontSize: 12.5,
      addressFont: "courier", addressFontSize: 13,
      radius: 3, panelRadius: 4, buttonRadius: 3, borderWidth: 3, borderStyle: "double", iconShape: "rounded",
      tabShape: "folder", tabRadius: 6, tabHeight: 32, tabIndicator: "underline", indicatorThickness: 2,
      addressShape: "rounded", addressRadius: 3, navHeight: 50,
      shadow: 35, shadowSoftness: 0, shadowOffset: 2, shadowColor: "#3a2c1e", cardShadows: true,
      grain: 22, vignette: 30, iconFilter: "sepia", iconFilterAmount: 55,
      ornaments: true, ornamentGlyph: "❦", stripeTop: "rule", stripeHeight: 4,
      background: "pattern", pattern: "linen", patternSize: 6, patternOpacity: 8, patternColor: "border", chromeOpacity: 94,
      animSpeed: 0.85, tabAnimation: "fade", clockWeight: 400, scrollbarColor: "text",
    },
    quick: ["mode", "accent", "font", "grain", "vignette", "iconFilter", "ornaments", "borderStyle"],
    presets: [
      { name: "Parchment", values: {} },
      { name: "Typewriter", values: { font: "courier", addressFont: "courier", "bg@light": "#e9e6df", "surface@light": "#f3f1ec", "surface2@light": "#e2ded5", "chromeBg@light": "#e2ded5", "railBg@light": "#dad5ca", "tabActiveBg@light": "#f3f1ec", "addressBg@light": "#faf9f6", "text@light": "#1d1d1d", "border@light": "#8c887e", accent: "#b22222", iconFilter: "grayscale", ornaments: false, borderStyle: "solid", borderWidth: 1, labelCase: "uppercase" } },
      { name: "Art Deco", values: { mode: "dark", accent: "#d4af37", accent2: "#8c6d1f", font: "century", labelCase: "uppercase", letterSpacing: 0.12, "bg@dark": "#111014", "surface@dark": "#1a181e", "surface2@dark": "#221f27", "hover@dark": "#2a2630", "border@dark": "#6b5520", "text@dark": "#f3e7c4", "chromeBg@dark": "#0e0d11", "railBg@dark": "#141217", "tabActiveBg@dark": "#221f27", "addressBg@dark": "#0b0a0d", pattern: "waves", patternColor: "accent", patternOpacity: 7, patternSize: 28, ornamentGlyph: "◆", tabShape: "slanted", iconFilterAmount: 30, grain: 10, vignette: 20 } },
      { name: "Sepia Photograph", values: { iconFilter: "sepia", iconFilterAmount: 100, vignette: 60, grain: 34, accent: "#6b4423", accent2: "#a67c52", "bg@light": "#e8d9bd", "surface@light": "#f1e5cc" } },
      { name: "Victorian", values: { mode: "dark", accent: "#b33a4c", accent2: "#c9a227", font: "garamond", ornamentGlyph: "❧", "bg@dark": "#132019", "surface@dark": "#1b2b22", "surface2@dark": "#22362a", "hover@dark": "#2a4033", "border@dark": "#4d5f3a", "text@dark": "#efe3c8", "chromeBg@dark": "#101b15", "railBg@dark": "#15241c", "tabActiveBg@dark": "#22362a", "addressBg@dark": "#0d1611" } },
      { name: "Newsprint", values: { font: "times", addressFont: "times", "bg@light": "#efece6", "surface@light": "#f7f5f1", "surface2@light": "#e8e4dc", "chromeBg@light": "#e8e4dc", "railBg@light": "#e1ddd4", "tabActiveBg@light": "#f7f5f1", "addressBg@light": "#fbfaf8", "text@light": "#111111", "border@light": "#8a8a8a", accent: "#111111", accent2: "#555555", iconFilter: "grayscale", grain: 25, pattern: "dots", patternSize: 4, patternOpacity: 10, patternColor: "text" } },
    ],
  },

  gamer: {
    name: "Gamer",
    tagline: "Opera GX energy -- angled tabs, glow, sounds and a red-hot accent",
    palette: {
      dark: { bg: "#0f0b14", surface: "#1a1422", surface2: "#221a2c", hover: "#2c2238", border: "#3a1f2b", text: "#f5eef8", textDim: "#b7a8bf", textFaint: "#6f6078", chromeBg: "#120d18", railBg: "#0c0910", tabActiveBg: "#251b2f", addressBg: "#0c0910", danger: "#ff3b5c", success: "#2ee59d", warning: "#ffb020" },
      light: { bg: "#f3eef4", surface: "#ffffff", surface2: "#efe6f1", hover: "#e6dae9", border: "#e2b9c6", text: "#1c1020", textDim: "#5c4a63", textFaint: "#9d8ca4", chromeBg: "#efe5f1", railBg: "#e7dbea", tabActiveBg: "#ffffff", addressBg: "#ffffff" },
    },
    defaults: {
      mode: "dark", accent: "#fa1e4e", accent2: "#ff7a00", accentGradient: true, gradientAngle: 100,
      font: "bahnschrift", fontStretch: 92, letterSpacing: 0.02, labelCase: "uppercase", headingWeight: 700,
      radius: 4, panelRadius: 6, buttonRadius: 4, cornerCut: 6, iconShape: "rounded",
      tabShape: "slanted", tabRadius: 4, tabHeight: 32, tabBarPad: 8, tabIndicator: "glow", indicatorThickness: 2,
      addressShape: "rounded", addressRadius: 4, navHeight: 48, glow: 14, focusStyle: "glow",
      background: "gradient", bgGradientA: "#1a0612", bgGradientB: "#0b0a12", bgGradientAngle: 150, chromeOpacity: 90,
      stripeTop: "gradient", stripeHeight: 2, windowControls: "minimal",
      uiSounds: "gx", typingSounds: true, uiSoundVolume: 40,
      easing: "snappy", tabAnimation: "slide", scrollbarWidth: 6, scrollbarColor: "accent", clockWeight: 600,
    },
    quick: ["accent", "accent2", "glow", "uiSounds", "typingSounds", "tabShape", "bgGradientA", "stripeTop"],
    presets: [
      { name: "GX Classic", values: {} },
      { name: "Hackerman", values: { accent: "#00ff41", accent2: "#00b3ff", bgGradientA: "#031a0a" } },
      { name: "Purple Haze", values: { accent: "#a855f7", accent2: "#ec4899", bgGradientA: "#150624" } },
      { name: "Frutti di Mare", values: { accent: "#00e1ff", accent2: "#ff4fa3", bgGradientA: "#04161f" } },
      { name: "Lambo", values: { accent: "#ffd000", accent2: "#ff6a00", bgGradientA: "#1a1400" } },
      { name: "Ultraviolet", values: { accent: "#7c3aed", accent2: "#22d3ee", glow: 22, bgGradientA: "#0d0620" } },
    ],
  },

  fluent: {
    name: "Fluent",
    tagline: "Right at home on Windows 11 -- calm, rounded and familiar",
    palette: {
      light: { bg: "#f3f3f3", surface: "#ffffff", surface2: "#f7f7f7", hover: "#ececec", border: "#e5e5e5", text: "#1b1b1b", textDim: "#5f5f5f", textFaint: "#9a9a9a", chromeBg: "#eeeeee", railBg: "#eeeeee", tabActiveBg: "#fbfbfb", addressBg: "#ffffff", danger: "#c42b1c", success: "#0f7b0f", warning: "#9d5d00" },
      dark: { bg: "#202020", surface: "#2b2b2b", surface2: "#323232", hover: "#3a3a3a", border: "#3d3d3d", text: "#ffffff", textDim: "#c5c5c5", textFaint: "#8a8a8a", chromeBg: "#1c1c1c", railBg: "#1c1c1c", tabActiveBg: "#2d2d2d", addressBg: "#2d2d2d", danger: "#ff99a4", success: "#6ccb5f", warning: "#fce100" },
    },
    defaults: {
      mode: "system", accent: "#0067c0", accent2: "#4cc2ff",
      font: "system", radius: 6, panelRadius: 8, buttonRadius: 5, iconShape: "rounded", iconStroke: 1.5,
      tabShape: "folder", tabRadius: 8, tabHeight: 32, tabBarPad: 8, tabIndicator: "none", tabGap: 2,
      addressShape: "rounded", addressRadius: 6, navHeight: 48, dividers: false,
      shadow: 18, shadowSoftness: 30, shadowOffset: 6, activeTabElevation: 20,
      easing: "smooth", tabAnimation: "fade", clockWeight: 300,
    },
    quick: ["mode", "accent", "background", "radius", "tabShape", "fontSize", "shadow", "dividers"],
    presets: [
      { name: "Light", values: { mode: "light" } },
      { name: "Dark", values: { mode: "dark" } },
      { name: "Mica glow", values: { background: "gradient", bgGradientA: "#dce6f5", bgGradientB: "#f3e8f2", chromeOpacity: 72, mode: "light" } },
      { name: "Sun Valley", values: { accent: "#c42b1c", accent2: "#ff8c00" } },
    ],
  },

  soft: {
    name: "Soft",
    tagline: "Neumorphic -- everything gently pressed out of one surface",
    palette: {
      light: { bg: "#e4e8ee", surface: "#e4e8ee", surface2: "#e4e8ee", hover: "#dde2e9", border: "#d0d6de", text: "#34405a", textDim: "#65708a", textFaint: "#9aa3b5", chromeBg: "#e4e8ee", railBg: "#e4e8ee", tabActiveBg: "#e4e8ee", addressBg: "#e4e8ee" },
      dark: { bg: "#2a2d34", surface: "#2a2d34", surface2: "#2e3139", hover: "#33363f", border: "#24262c", text: "#e6e9f0", textDim: "#a3a9b8", textFaint: "#6b7180", chromeBg: "#2a2d34", railBg: "#2a2d34", tabActiveBg: "#2a2d34", addressBg: "#2a2d34" },
    },
    defaults: {
      mode: "light", accent: "#6c7cff", accent2: "#ff8ab3", softShadows: true,
      font: "segoe", fontWeight: 500, radius: 14, panelRadius: 18, buttonRadius: 12, borderWidth: 0, iconShape: "circle", iconStroke: 2,
      tabShape: "rounded", tabRadius: 12, tabHeight: 32, tabBarPad: 9, tabGap: 8, tabIndicator: "dot",
      addressShape: "pill", addressHeight: 36, navHeight: 52, dividers: false, shadow: 0, railFloating: true,
      easing: "bouncy", hoverLift: 1, clockWeight: 300,
    },
    quick: ["mode", "accent", "softShadows", "radius", "tabShape", "hoverLift", "font", "railFloating"],
    presets: [
      { name: "Cloud", values: {} },
      { name: "Midnight", values: { mode: "dark" } },
      { name: "Mint", values: { accent: "#10b981", accent2: "#06b6d4" } },
      { name: "Lilac", values: { accent: "#8b5cf6", accent2: "#f472b6" } },
    ],
  },

  terminal: {
    name: "Terminal",
    tagline: "A green-screen console -- monospace, phosphor glow and scanlines",
    palette: {
      dark: { bg: "#0a0c0a", surface: "#0d110d", surface2: "#111811", hover: "#152015", border: "#1d3a1d", text: "#33ff66", textDim: "#22b347", textFaint: "#197a33", chromeBg: "#080a08", railBg: "#080a08", tabActiveBg: "#0f1a0f", addressBg: "#050705", danger: "#ff5555", success: "#33ff66", warning: "#ffcc00" },
      light: { bg: "#f4f1e8", surface: "#fbf9f3", surface2: "#efeadd", hover: "#e8e1cf", border: "#c9c0a8", text: "#1f2a1f", textDim: "#4a5a4a", textFaint: "#8a9a8a", chromeBg: "#efeadd", railBg: "#efeadd", tabActiveBg: "#fbf9f3", addressBg: "#ffffff" },
    },
    defaults: {
      mode: "dark", accent: "#33ff66", accent2: "#22d3ee", font: "cascadia", fontSize: 13,
      radius: 0, panelRadius: 0, buttonRadius: 0, iconShape: "square", iconStroke: 1.6,
      tabShape: "underline", tabIndicator: "underline", indicatorThickness: 2, tabHeight: 30,
      addressShape: "underline", navHeight: 46, focusStyle: "underline",
      textGlow: 5, glow: 6, scanlines: 14, scanlineSize: 3, vignette: 25,
      easing: "linear", animSpeed: 1.4, tabAnimation: "fade", clockWeight: 400, ntPanels: "bare",
      scrollbarShape: "square", scrollbarColor: "accent", scrollbarWidth: 8, uiSounds: "retro",
    },
    quick: ["accent", "font", "scanlines", "textGlow", "vignette", "tabShape", "mode", "typingSounds"],
    presets: [
      { name: "Green phosphor", values: {} },
      { name: "Amber", values: { accent: "#ffb000", "text@dark": "#ffb000", "textDim@dark": "#cc8a00", "textFaint@dark": "#7a5300", "border@dark": "#3a2a00" } },
      { name: "IBM blue", values: { accent: "#6ea8ff", "bg@dark": "#0a0f1f", "surface@dark": "#0d1428", "chromeBg@dark": "#080c18", "railBg@dark": "#080c18", "tabActiveBg@dark": "#101a33", "addressBg@dark": "#060a14", "text@dark": "#cfe0ff", "textDim@dark": "#8fb0e6", "textFaint@dark": "#4a6aa0", "border@dark": "#1d2f5a" } },
      { name: "Paper", values: { mode: "light", accent: "#1f6f3f", textGlow: 0, glow: 0, scanlines: 0, vignette: 0 } },
    ],
  },

  aqua: {
    name: "Aqua",
    tagline: "Y2K gloss -- candy buttons, pinstripes and bubbles",
    palette: {
      light: { bg: "#e8eef7", surface: "#f8fbff", surface2: "#eaf1fb", hover: "#dde8f7", border: "#9fb4d3", text: "#0d1b33", textDim: "#435677", textFaint: "#8193b0", chromeBg: "#d7e2f0", railBg: "#cdd9ea", tabActiveBg: "#ffffff", addressBg: "#ffffff" },
      dark: { bg: "#0f1826", surface: "#172336", surface2: "#1d2b42", hover: "#243552", border: "#2e4468", text: "#e8f1ff", textDim: "#9fb3d4", textFaint: "#5d7297", chromeBg: "#121d2e", railBg: "#101a2a", tabActiveBg: "#1d2b42", addressBg: "#0c1522" },
    },
    defaults: {
      mode: "light", accent: "#2a7fff", accent2: "#5ac8fa", accentGradient: true, gradientAngle: 180,
      font: "trebuchet", radius: 12, panelRadius: 14, buttonRadius: 16, iconShape: "circle",
      tabShape: "pill", tabHeight: 28, tabGap: 5, addressShape: "pill", tabIndicator: "none",
      gloss: 100, bevel: 35, shadow: 30, shadowSoftness: 14, shadowOffset: 4, cardShadows: true, toolbarButtons: "raised",
      background: "pattern", pattern: "lines", patternSize: 4, patternOpacity: 6, chromeOpacity: 92,
      windowControls: "mac", easing: "bouncy", hoverLift: 1, tabAnimation: "pop",
    },
    quick: ["accent", "gloss", "bevel", "pattern", "windowControls", "font", "mode", "tabShape"],
    presets: [
      { name: "Aqua", values: {} },
      { name: "Graphite", values: { accent: "#8e98a8", accent2: "#c7ced9" } },
      { name: "Bubblegum", values: { accent: "#ff5fa2", accent2: "#ffc2dd" } },
      { name: "Lime", values: { accent: "#3fbf3f", accent2: "#c8f7a8" } },
      { name: "Night", values: { mode: "dark" } },
    ],
  },

  brutal: {
    name: "Brutal",
    tagline: "Neo-brutalism -- thick outlines, hard shadows, loud colour",
    palette: {
      light: { bg: "#fff6d6", surface: "#ffffff", surface2: "#fff1b8", hover: "#ffe98a", border: "#111111", text: "#111111", textDim: "#333333", textFaint: "#666666", chromeBg: "#ffde59", railBg: "#ff90e8", tabActiveBg: "#ffffff", addressBg: "#ffffff", danger: "#ff3b3b", success: "#00b86b", warning: "#ff9f1c" },
      dark: { bg: "#1a1a1a", surface: "#262626", surface2: "#303030", hover: "#3a3a3a", border: "#f5f5f5", text: "#fafafa", textDim: "#d0d0d0", textFaint: "#9a9a9a", chromeBg: "#3d2bff", railBg: "#ff5ca8", tabActiveBg: "#262626", addressBg: "#262626" },
    },
    defaults: {
      mode: "light", accent: "#ff5ca8", accent2: "#3d2bff",
      font: "franklin", fontWeight: 600, headingWeight: 900, labelCase: "uppercase", iconStroke: 2.4,
      radius: 6, panelRadius: 8, buttonRadius: 6, borderWidth: 3, iconShape: "rounded",
      tabShape: "rounded", tabRadius: 6, tabHeight: 32, tabGap: 6, tabBarPad: 8, tabIndicator: "none", activeTabElevation: 60,
      addressShape: "rounded", addressRadius: 6, toolbarButtons: "outline", focusStyle: "outline",
      shadow: 100, shadowSoftness: 0, shadowOffset: 4, shadowColor: "#111111", cardShadows: true,
      hoverLift: 2, pressScale: 8, easing: "snappy", clockWeight: 900,
    },
    quick: ["accent", "borderWidth", "shadowOffset", "hoverLift", "font", "chromeBg", "railBg", "mode"],
    presets: [
      { name: "Pop", values: {} },
      { name: "Mono", values: { accent: "#111111", "chromeBg@light": "#ffffff", "railBg@light": "#f2f2f2" } },
      { name: "Candy", values: { accent: "#7b61ff", "chromeBg@light": "#b8f2e6", "railBg@light": "#ffd6a5" } },
      { name: "Night pop", values: { mode: "dark" } },
    ],
  },
};

// --- Colour helpers ----------------------------------------------------------------

function parseHex(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return "#" + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");
}

export function mixHex(a, b, percentOfB) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  const t = percentOfB / 100;
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

export function luminance(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

const rgbTriplet = (hex) => (parseHex(hex) || [255, 255, 255]).join(" ");
const alpha = (hex, a) => `rgb(${rgbTriplet(hex)} / ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

export function isHexColor(value) {
  return !!parseHex(value);
}

// --- Resolving: settings -> the values in effect -----------------------------------

// The style and your changes to every style. Settings saved before styles
// existed (ui_style empty) map onto Liquid Glass or, with glass off, Hyper
// Clean -- keeping the old dark/light choice, accent, custom colours, frost
// and wallpaper.
export function styleState(settings) {
  const s = settings || {};
  const custom = s.ui_custom && typeof s.ui_custom === "object" && !Array.isArray(s.ui_custom) ? s.ui_custom : {};
  if (s.ui_style && STYLES[s.ui_style]) return { id: s.ui_style, all: custom };
  const id = s.glass_enabled === false ? "clean" : "glass";
  const legacy = {};
  legacy.mode = s.theme === "light" ? "light" : "dark";
  if (s.accent && String(s.accent).toLowerCase() !== "#7c5cff") legacy.accent = s.accent;
  if (s.theme === "custom") {
    if (s.custom_bg) legacy["bg@dark"] = s.custom_bg;
    if (s.custom_surface) legacy["surface@dark"] = s.custom_surface;
    if (s.custom_text) legacy["text@dark"] = s.custom_text;
  }
  if (id === "glass") {
    if (s.glass_blur != null && s.glass_blur !== 14) legacy.glassBlur = s.glass_blur;
    if (s.glass_refraction === false) legacy.glassRefraction = false;
    if (s.wallpaper && s.wallpaper !== "nightfall") legacy.wallpaper = s.wallpaper;
  }
  return { id, all: { ...custom, [id]: { ...legacy, ...(custom[id] || {}) } } };
}

export function systemMode() {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// Default of `key` in style `id` (palette colours: see resolvePalette).
export function defaultValue(id, key) {
  const style = STYLES[id] || STYLES.glass;
  if (key in style.defaults) return style.defaults[key];
  return OPTION_MAP[key]?.def;
}

function resolvePalette(id, custom, mode, accent) {
  const style = STYLES[id] || STYLES.glass;
  const spec = { ...BASE_PALETTE, ...(style.palette[mode] || style.palette.dark) };
  const out = {};
  const defaults = {};
  const seen = new Set();
  const lookup = (key) => (key === "accent" ? accent : resolveKey(key));
  function evaluate(entry) {
    if (typeof entry === "string" && entry.startsWith("=")) return lookup(entry.slice(1));
    if (Array.isArray(entry)) {
      const [a, b, p] = entry;
      const ca = a.startsWith("#") ? a : lookup(a);
      const cb = b.startsWith("#") ? b : lookup(b);
      return mixHex(ca, cb, p);
    }
    return entry;
  }
  function resolveKey(key) {
    if (key in out) return out[key];
    if (seen.has(key)) return "#808080"; // a cycle -- never in the tables above
    seen.add(key);
    const def = evaluate(spec[key] ?? "#808080");
    defaults[key] = def;
    const mine = custom[`${key}@${mode}`];
    out[key] = isHexColor(mine) ? mine : def;
    return out[key];
  }
  for (const key of PALETTE_KEYS) resolveKey(key);
  return { palette: out, paletteDefaults: defaults };
}

// Everything in effect for `settings`: {id, mode, values, custom}, plus
// `defaults` -- what each value would be without your changes -- for the
// Settings page's reset buttons. `forStyle` resolves another style (the
// previews in Settings).
export function resolveStyle(settings, forStyle = null) {
  const state = styleState(settings);
  const id = forStyle && STYLES[forStyle] ? forStyle : state.id;
  const custom = state.all[id] || {};
  const values = {};
  const defaults = {};
  for (const opt of OPTIONS) {
    if (opt.perMode) continue;
    defaults[opt.key] = defaultValue(id, opt.key);
    values[opt.key] = custom[opt.key] !== undefined ? custom[opt.key] : defaults[opt.key];
  }
  const mode = values.mode === "system" ? systemMode() : values.mode === "light" ? "light" : "dark";
  const { palette, paletteDefaults } = resolvePalette(id, custom, mode, values.accent);
  for (const key of PALETTE_KEYS) {
    values[key] = palette[key];
    defaults[key] = paletteDefaults[key];
  }
  return { id, mode, values, defaults, custom, all: state.all };
}

// --- Building the CSS ---------------------------------------------------------------

// How much bigger the chrome is at each density, and a menu item's height.
export const DENSITIES = {
  compact: { label: "Compact", scale: 0.84, menuItem: 26 },
  normal: { label: "Normal", scale: 1, menuItem: 30 },
  touch: { label: "Touch", scale: 1.25, menuItem: 40 },
};
const DENSITY_KEYS = ["tabHeight", "tabBarPad", "navHeight", "buttonSize", "addressHeight", "bookmarksHeight", "railWidth", "railIcon", "railGap"];

const EASINGS = {
  smooth: "cubic-bezier(0.16, 1, 0.3, 1)",
  snappy: "cubic-bezier(0.2, 0.9, 0.1, 1)",
  bouncy: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  elastic: "cubic-bezier(0.68, -0.55, 0.27, 1.55)",
  sharp: "cubic-bezier(0.4, 0, 0.2, 1)",
  linear: "linear",
};

const TAB_ANIMATIONS = { pop: "tabEnter", fade: "k-tab-fade", slide: "k-tab-slide", drop: "k-tab-drop", flip: "k-tab-flip", none: "none" };

const chamfer = (c) => `polygon(${c}px 0, 100% 0, 100% calc(100% - ${c}px), calc(100% - ${c}px) 100%, 0 100%, 0 ${c}px)`;

const ICON_SHAPES = {
  squircle: { radius: "0", clip: "none" },
  circle: { radius: "50%", clip: "none" },
  rounded: { radius: "24%", clip: "none" },
  square: { radius: "0", clip: "none" },
  chamfer: { radius: "0", clip: "polygon(22% 0, 100% 0, 100% 78%, 78% 100%, 0 100%, 0 22%)" },
  hexagon: { radius: "0", clip: "polygon(25% 3%, 75% 3%, 100% 50%, 75% 97%, 25% 97%, 0 50%)" },
};

function colorFor(choice, values) {
  switch (choice) {
    case "accent2": return values.accent2;
    case "text": return values.text;
    case "white": return "#ffffff";
    case "border": return values.border;
    default: return values.accent;
  }
}

// The layers painted behind the toolbar and the new tab page for the
// pattern background.
export function patternCss(values) {
  const c = alpha(colorFor(values.patternColor, values), values.patternOpacity / 100);
  const s = values.patternSize;
  const dot = Math.max(1, s / 12);
  const soft = alpha(values.text, values.patternOpacity / 250);
  const layers = {
    grid: `linear-gradient(${c} 1px, transparent 1px) 0 0 / ${s}px ${s}px, linear-gradient(90deg, ${c} 1px, transparent 1px) 0 0 / ${s}px ${s}px`,
    dots: `radial-gradient(${c} ${dot.toFixed(1)}px, transparent ${(dot + 0.6).toFixed(1)}px) 0 0 / ${s}px ${s}px`,
    lines: `repeating-linear-gradient(0deg, ${c} 0 1px, transparent 1px ${s}px)`,
    diagonal: `repeating-linear-gradient(45deg, ${c} 0 1px, transparent 1px ${s}px)`,
    crosshatch: `repeating-linear-gradient(45deg, ${c} 0 1px, transparent 1px ${s}px), repeating-linear-gradient(-45deg, ${c} 0 1px, transparent 1px ${s}px)`,
    checker: `conic-gradient(${c} 25%, transparent 0 50%, ${c} 0 75%, transparent 0) 0 0 / ${s}px ${s}px`,
    carbon: `linear-gradient(27deg, ${c} ${s / 2}px, transparent ${s / 2}px) 0 ${s / 2}px / ${s * 2}px ${s * 2}px, linear-gradient(207deg, ${c} ${s / 2}px, transparent ${s / 2}px) ${s}px 0 / ${s * 2}px ${s * 2}px, linear-gradient(27deg, ${soft} ${s / 2}px, transparent ${s / 2}px) 0 ${s}px / ${s * 2}px ${s * 2}px, linear-gradient(207deg, ${soft} ${s / 2}px, transparent ${s / 2}px) ${s}px ${s / 2}px / ${s * 2}px ${s * 2}px`,
    waves: `radial-gradient(circle at 50% 100%, transparent 45%, ${c} 46% 50%, transparent 51%) 0 0 / ${s}px ${s / 2}px`,
    hazard: `repeating-linear-gradient(-45deg, ${alpha("#f5c400", values.patternOpacity / 100)} 0 ${s / 2}px, ${alpha("#111111", values.patternOpacity / 100)} ${s / 2}px ${s}px)`,
    linen: `repeating-linear-gradient(0deg, ${c} 0 1px, transparent 1px ${Math.max(2, s / 2)}px), repeating-linear-gradient(90deg, ${c} 0 1px, transparent 1px ${s}px)`,
    circuit: `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${s * 3}' height='${s * 3}' viewBox='0 0 60 60' fill='none' stroke='${colorFor(values.patternColor, values)}' stroke-opacity='${values.patternOpacity / 100}' stroke-width='1'><path d='M0 10h15l5 5v15l5 5h35M10 60V40l5-5h10M40 0v10l5 5h15M30 60V50l5-5h10l5-5V30'/><circle cx='25' cy='35' r='2'/><circle cx='50' cy='40' r='2'/><circle cx='45' cy='15' r='2'/></svg>`)}") 0 0 / ${s * 3}px ${s * 3}px`,
  };
  return `${layers[values.pattern] || layers.grid}, ${values.bg}`;
}

// What the backdrop layer (#wallpaper) paints for the gradient and pattern
// backgrounds; null for a wallpaper (glass.js paints those) or solid.
export function backdropCss(values) {
  if (values.background === "gradient") return `linear-gradient(${values.bgGradientAngle}deg, ${values.bgGradientA}, ${values.bgGradientB})`;
  if (values.background === "pattern") return patternCss(values);
  return null;
}

// Light or dark text over that backdrop (for glass).
export function backdropTone(values) {
  if (values.background === "gradient") return (luminance(values.bgGradientA) + luminance(values.bgGradientB)) / 2 > 0.25 ? "light" : "dark";
  if (values.background === "pattern") return luminance(values.bg) > 0.25 ? "light" : "dark";
  return null;
}

function grainImage(amount, mode) {
  const tone = mode === "light" ? "0" : "1";
  const a = (amount / 100) * 0.55;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 0 ${tone} 0 0 0 ${(a * 2.2).toFixed(3)} -${(a * 0.6).toFixed(3)}'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// The whole look as {vars, attrs, classes, css}: applied to <html> by
// applyLook, and cached so the next page load paints it before settings
// arrive from Rust.
export function buildLook(r, settings) {
  // Settings -> Appearance -> Density: whatever the style, its tab strip,
  // toolbar, bookmarks bar, rail and menus a size smaller, or bigger to
  // touch.
  const density = DENSITIES[settings?.features?.ui_density] ? settings.features.ui_density : "normal";
  const scale = DENSITIES[density].scale;
  const v = scale === 1 ? r.values : { ...r.values, ...Object.fromEntries(DENSITY_KEYS.map((key) => [key, Math.round(r.values[key] * scale)])) };
  const px = (n) => `${Math.round(n * 100) / 100}px`;
  const vars = {};
  const attrs = {};
  const classes = {};
  const glass = r.id === "glass";

  // Colour
  const tinted = (hex) => (v.surfaceTint > 0 ? mixHex(hex, v.accent, v.surfaceTint) : hex);
  const strength = v.textContrast;
  vars["--bg"] = tinted(v.bg);
  vars["--surface"] = tinted(v.surface);
  vars["--surface-2"] = tinted(v.surface2);
  vars["--surface-hover"] = tinted(v.hover);
  vars["--border"] = v.neonBorders ? mixHex(v.accent, v.bg, 55) : v.border;
  vars["--text"] = v.text;
  vars["--text-dim"] = strength > 0 ? mixHex(v.textDim, v.text, strength) : v.textDim;
  vars["--text-faint"] = strength > 0 ? mixHex(v.textFaint, v.text, strength) : v.textFaint;
  vars["--danger"] = v.danger;
  vars["--success"] = v.success;
  vars["--warning"] = v.warning;
  vars["--accent"] = v.accent;
  vars["--accent-2"] = v.accent2;
  vars["--accent-text"] = v.accentText === "light" ? "#ffffff" : v.accentText === "dark" ? "#0b0b10" : luminance(v.accent) > 0.45 ? "#0b0b10" : "#ffffff";
  vars["--k-accent-fill"] = v.accentGradient ? `linear-gradient(${v.gradientAngle}deg, ${v.accent}, ${v.accent2})` : v.accent;
  vars["--k-selection"] = v.selection;
  vars["--k-link"] = v.link;
  vars["--k-tab-active-bg"] = tinted(v.tabActiveBg);
  vars["--k-address-bg"] = tinted(v.addressBg);
  const seeThrough = v.background !== "solid" && !glass;
  const fill = (hex) => (seeThrough && v.chromeOpacity < 100 ? `color-mix(in srgb, ${hex} ${v.chromeOpacity}%, transparent)` : hex);
  vars["--k-chrome-fill"] = fill(tinted(v.chromeBg));
  vars["--k-rail-fill"] = fill(tinted(v.railBg));

  // Typography
  vars["--font"] = fontStack(v.font, v.fontCustom);
  vars["--font-scale"] = (((settings?.font_scale ?? 1) * v.fontSize) / 13.5).toFixed(4);
  vars["--k-weight"] = String(v.fontWeight);
  vars["--k-weight-strong"] = String(v.headingWeight);
  vars["--k-letter"] = `${v.letterSpacing}em`;
  vars["--k-stretch"] = `${v.fontStretch}%`;
  const caseVars = (value) => (value === "smallcaps" ? ["none", "small-caps"] : [value, "normal"]);
  if (v.labelCase !== "asis") [vars["--k-label-case"], vars["--k-label-variant"]] = caseVars(v.labelCase);
  if (v.tabTextCase !== "asis") [vars["--k-tab-case"], vars["--k-tab-variant"]] = caseVars(v.tabTextCase);
  classes["k-label-case"] = v.labelCase !== "asis";
  classes["k-tab-case"] = v.tabTextCase !== "asis";
  vars["--k-tab-font"] = px(v.tabFontSize);
  vars["--k-address-font"] = v.addressFont === "same" ? "inherit" : fontStack(v.addressFont, v.fontCustom);
  vars["--k-address-font-size"] = px(v.addressFontSize);
  const glowHex = colorFor(v.glowColor, v);
  vars["--k-glow-color"] = glowHex;
  vars["--k-text-glow"] = v.textGlow > 0 ? `0 0 ${v.textGlow}px ${alpha(glowHex, 0.75)}` : "none";
  classes["k-text-glow"] = v.textGlow > 0;

  // Shape
  vars["--radius-sm"] = px(Math.round(v.radius * 0.66));
  vars["--radius"] = px(v.radius);
  vars["--radius-lg"] = px(Math.round(v.radius * 1.5));
  vars["--k-panel-radius"] = px(v.panelRadius);
  vars["--k-popup-radius"] = px(Math.min(v.panelRadius, 18));
  vars["--k-btn-radius"] = px(v.buttonRadius);
  vars["--k-border-w"] = px(v.borderWidth);
  vars["--k-border-style"] = v.borderStyle;
  vars["--k-cut"] = px(v.cornerCut);
  const icon = ICON_SHAPES[v.iconShape] || ICON_SHAPES.squircle;
  attrs["data-k-icon-shape"] = v.iconShape;
  vars["--k-icon-radius"] = icon.radius;
  vars["--k-icon-clip"] = icon.clip;

  // Tabs
  const R = v.tabRadius;
  const tabShape = {
    folder: [`${R}px ${R}px 0 0`, "none"],
    rounded: [`${R}px`, "none"],
    pill: ["999px", "none"],
    square: ["0", "none"],
    slanted: [`${Math.min(R, 6)}px ${Math.min(R, 6)}px 0 0`, "polygon(9px 0, calc(100% - 9px) 0, 100% 100%, 0 100%)"],
    chamfer: ["0", chamfer(Math.min(v.cornerCut, 10))],
    underline: ["0", "none"],
  }[v.tabShape] || [`${R}px`, "none"];
  attrs["data-k-tab-shape"] = v.tabShape;
  vars["--k-tab-rad"] = tabShape[0];
  vars["--k-tab-clip"] = tabShape[1];
  vars["--k-tab-h"] = px(v.tabHeight);
  vars["--k-tab-w"] = px(v.tabWidth);
  vars["--k-tab-gap"] = px(v.tabGap);
  vars["--k-tab-pad"] = px(v.tabPadding);
  attrs["data-k-indicator"] = v.tabIndicator;
  vars["--k-ind"] = px(v.indicatorThickness);
  classes["k-tab-sep"] = v.tabSeparators;
  attrs["data-k-close"] = v.closeButton;
  classes["k-no-favicons"] = !v.showFavicons;
  const shadowHex = v.shadowColor;
  const e = v.activeTabElevation / 100;
  vars["--k-tab-shadow"] = e > 0 ? `0 ${px(2 + e * 4)} ${px(4 + e * 14)} ${alpha(shadowHex, 0.12 + e * 0.35)}` : "0 0 #0000";

  // Toolbar
  vars["--k-tabbar-pad"] = px(v.tabBarPad);
  attrs["data-k-density"] = density;
  vars["--k-menu-item-h"] = px(DENSITIES[density].menuItem);
  vars["--k-nav-h"] = px(v.navHeight);
  vars["--k-btn"] = px(v.buttonSize);
  attrs["data-k-buttons"] = glass ? "glass" : v.toolbarButtons;
  vars["--k-icon-scale"] = String(v.iconScale);
  vars["--k-icon-stroke"] = String(v.iconStroke);
  const addressShape = {
    pill: ["999px", "none"],
    rounded: [px(v.addressRadius), "none"],
    square: ["0", "none"],
    chamfer: ["0", chamfer(Math.min(v.cornerCut, 12))],
    underline: ["0", "none"],
  }[v.addressShape] || ["999px", "none"];
  attrs["data-k-address-shape"] = v.addressShape;
  vars["--k-address-rad"] = addressShape[0];
  vars["--k-address-clip"] = addressShape[1];
  vars["--k-address-h"] = px(v.addressHeight);
  vars["--k-address-align"] = v.addressAlign;
  vars["--k-bm-h"] = px(v.bookmarksHeight);
  vars["--k-divider-w"] = v.dividers ? "1px" : "0px";
  attrs["data-k-winctl"] = v.windowControls;
  attrs["data-k-stripe"] = v.stripeTop;
  vars["--k-stripe-h"] = px(v.stripeHeight);
  vars["--k-stripe"] = {
    none: "none",
    accent: v.accent,
    gradient: `linear-gradient(90deg, ${v.accent}, ${v.accent2})`,
    hazard: "repeating-linear-gradient(-45deg, #f5c400 0 9px, #16181b 9px 18px)",
    rainbow: "linear-gradient(90deg, #ff5f6d, #ffc371, #47e891, #3ab0ff, #a86bff, #ff5f6d)",
    rule: `linear-gradient(${v.text}, ${v.text}) top / 100% 1px no-repeat, linear-gradient(${v.text}, ${v.text}) bottom / 100% 1px no-repeat`,
  }[v.stripeTop] || "none";

  // Rail
  vars["--k-rail-w"] = px(v.railWidth);
  vars["--k-rail-icon"] = px(v.railIcon);
  vars["--k-rail-gap"] = px(v.railGap);
  classes["k-rail-float"] = v.railFloating && !glass;
  classes["k-no-logo"] = !v.showRailLogo;

  // Background
  attrs["data-k-bg"] = v.background;
  classes["k-wall"] = v.background !== "solid" && !glass;
  const wallFilter = [];
  if (v.background !== "solid") {
    if (v.wallBlur > 0) wallFilter.push(`blur(${v.wallBlur}px)`);
    if (v.wallSaturate !== 100) wallFilter.push(`saturate(${v.wallSaturate / 100})`);
    if (v.wallDim > 0) wallFilter.push(`brightness(${(1 - v.wallDim / 100).toFixed(2)})`);
  }
  vars["--k-wall-filter"] = wallFilter.join(" ") || "none";
  vars["--k-wall-inset"] = v.wallBlur > 0 && v.background !== "solid" ? px(-v.wallBlur * 2) : "0px";
  classes["k-ambient"] = v.ambientMotion && (v.background === "gradient" || v.background === "pattern");

  // Depth
  const s = v.shadow / 100;
  vars["--shadow"] = s > 0 ? `0 ${px(v.shadowOffset)} ${px(v.shadowSoftness)} ${alpha(shadowHex, s * 0.9)}` : "0 0 #0000";
  vars["--k-shadow-sm"] = s > 0 ? `0 ${px(Math.ceil(v.shadowOffset / 2))} ${px(v.shadowSoftness / 2.5)} ${alpha(shadowHex, s * 0.7)}` : "0 0 #0000";
  const b = v.bevel / 100;
  const lightTop = r.mode === "light" ? 0.7 : 0.14;
  const bevelRaise = b > 0 ? `inset 0 1px 0 ${alpha("#ffffff", lightTop * b)}, inset 0 -2px 0 ${alpha("#000000", 0.32 * b)}` : "";
  const cardShadow = v.cardShadows && s > 0 ? `0 ${px(Math.max(1, Math.ceil(v.shadowOffset / 1.5)))} ${px(v.shadowSoftness / 2)} ${alpha(shadowHex, s * 0.75)}` : "";
  vars["--k-raise"] = [bevelRaise, cardShadow].filter(Boolean).join(", ") || "0 0 #0000";
  vars["--k-sunken"] = b > 0 ? `inset 0 2px 3px ${alpha("#000000", 0.35 * b)}, inset 0 -1px 0 ${alpha("#ffffff", lightTop * 0.5 * b)}` : "0 0 #0000";
  classes["k-bevel"] = b > 0 || (v.cardShadows && s > 0);
  classes["k-soft"] = !!v.softShadows;
  vars["--k-soft-light"] = alpha(mixHex(v.bg, "#ffffff", r.mode === "light" ? 75 : 10), r.mode === "light" ? 0.95 : 0.55);
  vars["--k-soft-dark"] = alpha(mixHex(v.bg, "#000000", r.mode === "light" ? 22 : 55), r.mode === "light" ? 0.7 : 0.8);
  const g = v.gloss / 100;
  vars["--k-gloss"] = g > 0 ? `linear-gradient(180deg, ${alpha("#ffffff", 0.22 * g)}, ${alpha("#ffffff", 0.04 * g)} 55%, ${alpha("#ffffff", 0)})` : "none";
  classes["k-gloss"] = g > 0;
  vars["--k-glow"] = px(v.glow);
  classes["k-glow"] = v.glow > 0;
  attrs["data-k-focus"] = v.focusStyle;
  vars["--k-lift"] = px(v.hoverLift);
  vars["--k-press"] = String(1 - v.pressScale / 100);

  // Glass
  vars["--lg-blur"] = px(v.glassBlur);
  vars["--lg-sat"] = String(v.glassSaturation / 100);
  vars["--k-glass-rgb"] = rgbTriplet(v.glassTintColor);
  vars["--k-glass-tint"] = String(v.glassTint / 100);
  vars["--k-glass-rim"] = String(v.glassRim / 100);
  vars["--k-glass-gloss"] = String(v.glassGloss / 100);
  vars["--k-glass-shadow"] = String(v.glassShadow / 100);

  // Texture & atmosphere
  const overlay = [];
  const sizes = [];
  if (v.grain > 0) {
    overlay.push(grainImage(v.grain, r.mode));
    sizes.push("160px 160px");
  }
  if (v.scanlines > 0) {
    overlay.push(`repeating-linear-gradient(180deg, transparent 0 ${v.scanlineSize - 1}px, ${alpha(r.mode === "light" ? "#003040" : "#000000", (v.scanlines / 100) * 0.55)} ${v.scanlineSize - 1}px ${v.scanlineSize}px)`);
    sizes.push("auto");
  }
  if (v.vignette > 0) {
    overlay.push(`radial-gradient(ellipse at center, transparent 55%, ${alpha(r.mode === "light" ? "#3a2c1e" : "#000000", (v.vignette / 100) * 0.7)} 100%)`);
    sizes.push("100% 100%");
  }
  classes["k-overlay"] = overlay.length > 0;
  vars["--k-overlay"] = overlay.join(", ") || "none";
  vars["--k-overlay-size"] = sizes.join(", ") || "auto";
  const amount = v.iconFilterAmount / 100;
  vars["--k-icon-filter"] = {
    none: "none",
    grayscale: `grayscale(${amount})`,
    sepia: `sepia(${amount}) saturate(${(1 - amount * 0.3).toFixed(2)})`,
    vivid: `saturate(${(1 + amount * 1.2).toFixed(2)}) contrast(${(1 + amount * 0.1).toFixed(2)})`,
    faded: `saturate(${(1 - amount * 0.6).toFixed(2)}) opacity(${(1 - amount * 0.35).toFixed(2)})`,
    invert: `invert(${amount}) hue-rotate(${Math.round(amount * 180)}deg)`,
  }[v.iconFilter] || "none";

  // Flourishes
  classes["k-neon"] = v.neonBorders;
  classes["k-hud"] = v.hudBrackets;
  classes["k-anim-border"] = v.animatedBorder;
  classes["k-rivets"] = v.rivets;
  classes["k-ornaments"] = v.ornaments;
  vars["--k-ornament"] = JSON.stringify(String(v.ornamentGlyph || "❦"));
  classes["k-glitch"] = v.glitch;
  classes["k-pulse"] = v.pulse;

  // Motion
  const speed = Math.max(0.1, v.animSpeed);
  vars["--dur-fast"] = `${(0.12 / speed).toFixed(3)}s`;
  vars["--dur"] = `${(0.2 / speed).toFixed(3)}s`;
  vars["--dur-slow"] = `${(0.36 / speed).toFixed(3)}s`;
  vars["--ease"] = EASINGS[v.easing] || EASINGS.smooth;
  vars["--k-tab-anim"] = TAB_ANIMATIONS[v.tabAnimation] || "tabEnter";
  vars["--k-tab-anim-dur"] = `${(0.18 / speed).toFixed(3)}s`;

  // New tab page
  classes["k-nt-no-clock"] = !v.ntClock;
  classes["k-nt-no-date"] = !v.ntDate;
  classes["k-nt-no-speed"] = !v.ntSpeedDial;
  classes["k-nt-no-bm"] = !v.ntBookmarks;
  classes["k-nt-bare"] = v.ntPanels === "bare";
  classes["k-nt-center"] = v.ntAlign === "center";
  vars["--k-clock-size"] = px(v.clockSize);
  vars["--k-clock-weight"] = String(v.clockWeight);
  vars["--k-nt-search-w"] = px(v.ntSearchWidth);
  vars["--k-nt-tile"] = px(v.ntTileSize);

  // Scrollbars
  vars["--k-sb-w"] = px(v.scrollbarWidth);
  vars["--k-sb-rad"] = v.scrollbarShape === "square" ? "0" : "10px";
  vars["--k-sb-thumb"] = v.scrollbarColor === "accent" ? alpha(v.accent, 0.55) : v.scrollbarColor === "text" ? alpha(v.text, 0.45) : "var(--border)";
  classes["k-sb-hidden"] = v.scrollbarWidth === 0;

  attrs["data-ui-style"] = r.id;
  attrs["data-theme"] = r.mode;
  attrs["data-k-mode"] = r.mode;
  classes["k-solid"] = !glass;

  return { vars, attrs, classes, css: String(v.customCss || "") };
}

// --- Applying --------------------------------------------------------------------

const CACHE_KEY = "kessel.style.cache";
const ALL_CLASSES = [
  "k-label-case", "k-tab-case", "k-text-glow", "k-tab-sep", "k-no-favicons", "k-rail-float", "k-no-logo", "k-wall",
  "k-ambient", "k-bevel", "k-gloss", "k-glow", "k-overlay", "k-neon", "k-hud", "k-anim-border", "k-rivets",
  "k-ornaments", "k-glitch", "k-pulse", "k-nt-no-clock", "k-nt-no-date", "k-nt-no-speed", "k-nt-no-bm", "k-nt-bare",
  "k-nt-center", "k-sb-hidden", "k-solid", "k-soft",
];
let appliedVars = new Set();

export function applyLook(look, root = document.documentElement) {
  const next = new Set();
  for (const [name, value] of Object.entries(look.vars)) {
    root.style.setProperty(name, value);
    next.add(name);
  }
  for (const name of appliedVars) if (!next.has(name)) root.style.removeProperty(name);
  appliedVars = next;
  for (const [name, value] of Object.entries(look.attrs)) root.setAttribute(name, value);
  for (const name of ALL_CLASSES) root.classList.toggle(name, !!look.classes[name]);
  root.style.colorScheme = look.attrs["data-k-mode"] === "light" ? "light" : "dark";

  let style = document.getElementById("k-user-css");
  if (look.css) {
    if (!style) {
      style = document.createElement("style");
      style.id = "k-user-css";
    }
    if (style.textContent !== look.css) style.textContent = look.css;
    // Last in <head>, so it wins over every page's own CSS.
    const head = document.head || root;
    if (style !== head.lastElementChild) head.appendChild(style);
  } else if (style) {
    style.remove();
  }
}

// Applies `settings`' style to this page; returns what was resolved.
export function applyStyle(settings) {
  const r = resolveStyle(settings);
  const look = buildLook(r, settings);
  applyLook(look);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(look));
  } catch {}
  return r;
}

// The look this page had last time, painted straight away while the real
// settings are still on their way from Rust (no flash of the default look).
export function applyCachedLook() {
  try {
    const look = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (look?.vars && look.attrs && look.classes) applyLook(look);
  } catch {}
}
