import { POWERSHELL_COMMAND_POLICIES } from "./powershell-command-policy.js";

const FILE_TYPE_ROWS = {
  opaque: ".ade .adp .apk .app .appcontent-ms .application .appref-ms .appx .asp .aspx .asx .bas .bat .bgi .cab .cdxml .cer .chm .cmd .cnt .com .cpl .crt .csh .der .diagcab .exe .fxp .gadget .grp .hlp .hpj .hta .htc .img .inf .ins .iso .isp .its .jar .jnlp .js .jse .ksh .library-ms .lnk .mad .maf .mag .mam .maq .mar .mas .mat .mau .mav .maw .mcf .mda .mdb .mde .mdt .mdw .mdz .msc .mht .mhtml .msh .msh1 .msh2 .mshxml .msh1xml .msh2xml .msi .msp .mst .msu .ops .osd .pcd .pif .pl .plg .prf .prg .printerexport .ps1xml .ps2 .ps2xml .psc1 .psc2 .psd1 .psdm1 .pssc .pst .py .pyc .pyo .pyw .pyz .pyzw .reg .scf .scr .sct .search-ms .settingcontent-ms .shb .shs .theme .tmp .udl .url .vb .vbe .vbp .vbs .vhd .vhdx .vsmacros .vsw .webpnp .website .ws .wsb .wsc .wsf .wsh .xbap .xll .xnk",
  script: ".ps1 .psm1",
  document: ".aac .abw .apng .avif .avi .azw .bmp .cda .css .csv .doc .docx .epub .gif .htm .html .ico .ics .jpeg .jpg .json .jsonld .md .mid .midi .m4a .mp3 .mp4 .mpeg .odp .ods .odt .oga .ogv .ogx .opus .png .pdf .ppt .pptx .rtf .svg .tif .tiff .txt .vsd .wav .weba .webm .webp .xhtml .xls .xlsx .xml .3gp .3g2",
} as const;

function fileTypes(): Readonly<Record<string, keyof typeof FILE_TYPE_ROWS>> {
  const types = Object.fromEntries(Object.entries(FILE_TYPE_ROWS).flatMap(([type, extensions]) =>
    extensions.split(" ").map((extension) => [extension, type as keyof typeof FILE_TYPE_ROWS])));
  for (const [name, policy] of Object.entries(POWERSHELL_COMMAND_POLICIES)) {
    const extension = /\.[^./]+$/.exec(name)?.[0];
    if (policy.native && extension !== undefined) types[extension] ??= "opaque";
  }
  return Object.freeze(types);
}

export const POWERSHELL_FILE_TYPES = fileTypes();
