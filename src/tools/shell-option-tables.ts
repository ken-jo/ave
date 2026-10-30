/** Option roles control arity before any argument receives a data exemption. */
export interface ShellOptionTable {
  flag: readonly string[];
  data: readonly string[];
  optionalData: readonly string[];
  path: readonly string[];
  writePath: readonly string[];
  config: readonly string[];
  structured: readonly string[];
}

// Source: curl.exe 8.16.0, `curl --help all`; structured syntax: curl manual.
export const CURL_OPTION_TABLE: ShellOptionTable = {
  flag: [
    "--anyauth", "-a", "--append", "--basic", "--ca-native", "--cert-status", "--compressed",
    "--compressed-ssh", "--create-dirs", "--crlf", "--digest", "-q", "--disable", "--disable-eprt",
    "--disable-epsv", "--disallow-username-in-url", "--doh-cert-status", "--doh-insecure",
    "--dump-ca-embed", "-f", "--fail", "--fail-early", "--fail-with-body", "--false-start", "--follow",
    "--form-escape", "--ftp-create-dirs", "--ftp-pasv", "--ftp-pret", "--ftp-skip-pasv-ip",
    "--ftp-ssl-ccc", "--ftp-ssl-control", "-G", "--get", "-g", "--globoff", "--haproxy-protocol", "-I",
    "--head", "--http0.9", "-0", "--http1.0", "--http1.1", "--http2", "--http2-prior-knowledge",
    "--http3", "--http3-only", "--ignore-content-length", "-k", "--insecure", "-4", "--ipv4", "-6",
    "--ipv6", "-j", "--junk-session-cookies", "-l", "--list-only", "-L", "--location",
    "--location-trusted", "--mail-rcpt-allowfails", "-M", "--manual", "--metalink", "--mptcp",
    "--negotiate", "-n", "--netrc", "--netrc-optional", "-:", "--next", "--no-alpn", "-N",
    "--no-buffer", "--no-clobber", "--no-keepalive", "--no-npn", "--no-progress-meter",
    "--no-sessionid", "--ntlm", "--ntlm-wb", "--out-null", "-Z", "--parallel", "--parallel-immediate",
    "--path-as-is", "--post301", "--post302", "--post303", "-#", "--progress-bar", "--proxy-anyauth",
    "--proxy-basic", "--proxy-ca-native", "--proxy-digest", "--proxy-http2", "--proxy-insecure",
    "--proxy-negotiate", "--proxy-ntlm", "--proxy-ssl-allow-beast", "--proxy-ssl-auto-client-cert",
    "--proxy-tlsv1", "-p", "--proxytunnel", "--raw", "-J", "--remote-header-name", "-O",
    "--remote-name", "--remote-name-all", "-R", "--remote-time", "--remove-on-error",
    "--retry-all-errors", "--retry-connrefused", "--sasl-ir", "-S", "--show-error", "-i",
    "--show-headers", "-s", "--silent", "--skip-existing", "--socks5-basic", "--socks5-gssapi",
    "--socks5-gssapi-nec", "--ssl", "--ssl-allow-beast", "--ssl-auto-client-cert", "--ssl-no-revoke",
    "--ssl-reqd", "--ssl-revoke-best-effort", "-2", "--sslv2", "-3", "--sslv3", "--styled-output",
    "--suppress-connect-headers", "--tcp-fastopen", "--tcp-nodelay", "--tftp-no-options",
    "--tls-earlydata", "-1", "--tlsv1", "--tlsv1.0", "--tlsv1.1", "--tlsv1.2", "--tlsv1.3",
    "--tr-encoding", "--trace-ids", "--trace-time", "-B", "--use-ascii", "-v", "--verbose", "-V",
    "--version", "--xattr",
  ],
  data: [
    "--aws-sigv4", "--cert-type", "--ciphers", "--connect-timeout", "--connect-to", "-C",
    "--continue-at", "--create-file-mode", "--curves", "--data-raw", "--delegation", "--dns-interface",
    "--dns-ipv4-addr", "--dns-ipv6-addr", "--dns-servers", "--doh-url", "--engine",
    "--expect100-timeout", "--form-string", "--ech", "--ftp-account", "--ftp-alternative-to-user",
    "--ftp-method", "-P", "--ftp-port", "--ftp-ssl-ccc-mode", "--happy-eyeballs-timeout-ms",
    "--haproxy-clientip", "--hostpubmd5", "--hostpubsha256", "--interface", "--ip-tos",
    "--ipfs-gateway", "--keepalive-cnt", "--keepalive-time", "--key-type", "--krb", "--limit-rate",
    "--local-port", "--login-options", "--mail-auth", "--mail-from", "--mail-rcpt", "--max-filesize",
    "--max-redirs", "-m", "--max-time", "--noproxy", "--oauth2-bearer", "--parallel-max",
    "--parallel-max-host", "--pass", "--preproxy", "--proto", "--proto-default", "--proto-redir", "-x",
    "--proxy", "--proxy-cert-type", "--proxy-ciphers", "--proxy-key-type", "--proxy-pass",
    "--proxy-service-name", "--proxy-tls13-ciphers", "--proxy-tlsauthtype", "--proxy-tlspassword",
    "--proxy-tlsuser", "-U", "--proxy-user", "--proxy1.0", "-Q", "--quote", "-r", "--range", "--rate",
    "-e", "--referer", "-X", "--request", "--request-target", "--resolve", "--retry", "--retry-delay",
    "--retry-max-time", "--sasl-authzid", "--service-name", "--sigalgs", "--socks4", "--socks4a",
    "--socks5", "--socks5-gssapi-service", "--socks5-hostname", "-Y", "--speed-limit", "-y",
    "--speed-time", "-t", "--telnet-option", "--tftp-blksize", "--tls-max", "--tls13-ciphers",
    "--tlsauthtype", "--tlspassword", "--tlsuser", "--trace-config", "--upload-flags", "-u", "--user",
    "-A", "--user-agent", "--vlan-priority",
  ],
  optionalData: ["-h", "--help"],
  path: [
    "--abstract-unix-socket", "--cacert", "--capath", "--crlfile", "--egd-file", "--etag-compare",
    "--key", "--netrc-file", "--proxy-cacert", "--proxy-capath", "--proxy-crlfile", "--proxy-key",
    "--pubkey", "--random-file", "--unix-socket", "-T", "--upload-file",
  ],
  writePath: [
    "--alt-svc", "-c", "--cookie-jar", "-D", "--dump-header", "--etag-save",
    "--hsts", "--libcurl", "-o", "--output", "--output-dir", "--ssl-sessions",
    "--stderr", "--trace", "--trace-ascii",
  ],
  config: ["-K", "--config"],
  structured: [
    "-E", "--cert", "-b", "--cookie", "-d", "--data", "--data-ascii", "--data-binary",
    "--data-urlencode", "-F", "--form", "-H", "--header", "--json", "--pinnedpubkey",
    "--proxy-cert", "--proxy-header", "--proxy-pinnedpubkey", "-z", "--time-cond", "--url",
    "--url-query", "--variable", "-w", "--write-out",
  ],
};

// Source: wget 1.21.4 doc/wget.texi and src/init.c define option roles and file-command aliases.
// -n uses negation letters; multi-letter aliases are exact flags, never clusters.
export const WGET_OPTION_TABLE: ShellOptionTable = {
  optionalData: [],
  flag: [
    "-V", "--version", "-h", "--help", "-b", "--background", "-d", "--debug", "-q", "--quiet", "-v",
    "--verbose", "-nv", "--no-verbose", "--keep-badhash", "--metalink-over-http", "--xattr", "-F",
    "--force-html", "-nc", "--no-clobber", "--no-netrc", "-c", "--continue", "--show-progress", "-N",
    "--timestamping", "--no-if-modified-since", "--no-use-server-timestamps", "-S", "--server-response",
    "--spider", "--random-wait", "--no-proxy", "--no-dns-cache", "-4", "--inet4-only", "-6",
    "--inet6-only", "--retry-connrefused", "--ask-password", "--no-iri", "--unlink", "-nd",
    "--no-directories", "-x", "--force-directories", "-nH", "--no-host-directories",
    "--protocol-directories", "-E", "--adjust-extension", "--no-http-keep-alive", "--no-cache",
    "--no-cookies", "--keep-session-cookies", "--ignore-length", "--save-headers",
    "--content-disposition", "--content-on-error", "--trust-server-names", "--auth-no-challenge",
    "--retry-on-host-error", "--https-only", "--no-check-certificate", "--no-hsts", "--warc-cdx",
    "--no-warc-compression", "--no-warc-digests", "--no-warc-keep-log", "--no-remove-listing",
    "--no-glob", "--no-passive-ftp", "--preserve-permissions", "--retr-symlinks", "--ftps-implicit",
    "--no-ftps-resume-ssl", "--ftps-clear-data-connection", "--ftps-fallback-to-ftp", "-r",
    "--recursive", "--delete-after", "-k", "--convert-links", "--convert-file-only", "-K",
    "--backup-converted", "-m", "--mirror", "-p", "--page-requisites", "--strict-comments",
    "--follow-ftp", "--ignore-case", "-H", "--span-hosts", "-L", "--relative", "-np", "--no-parent",
    "--no-config",
  ],
  data: [
    "-n", "--report-speed", "--metalink-index", "--preferred-location", "-B", "--base",
    "--bind-address", "--bind-dns-address", "--dns-servers", "-t", "--tries", "--backups",
    "--start-pos", "--progress", "-T", "--timeout", "--dns-timeout", "--connect-timeout",
    "--read-timeout", "--limit-rate", "-w", "--wait", "--waitretry", "-Q", "--quota",
    "--restrict-file-names", "--prefer-family", "--user", "--password", "--local-encoding",
    "--remote-encoding", "--cut-dirs", "--http-user", "--http-password", "--header",
    "--compression", "--max-redirect", "--proxy-user", "--proxy-password", "--referer", "-U",
    "--user-agent", "--post-data", "--method", "--body-data", "--retry-on-http-error",
    "--secure-protocol", "--ciphers", "--certificate-type", "--private-key-type", "--warc-header",
    "--warc-max-size", "--ftp-user", "--ftp-password", "-l", "--level", "-A", "--accept", "-R",
    "--reject", "--accept-regex", "--reject-regex", "--regex-type", "-D", "--domains",
    "--exclude-domains", "--follow-tags", "--ignore-tags", "-I", "--include-directories", "-X",
    "--exclude-directories",
  ],
  path: [
    "-i", "--input-file", "--input-metalink", "--use-askpass", "--load-cookies", "--post-file",
    "--body-file", "--certificate", "--private-key", "--ca-certificate", "--ca-directory", "--crl-file",
    "--random-file", "--egd-file", "--warc-dedup",
  ],
  writePath: [
    "-o", "--output-file", "-a", "--append-output", "--rejected-log", "-O",
    "--output-document", "-P", "--directory-prefix", "--save-cookies", "--hsts-file", "--warc-file",
    "--warc-tempdir", "--default-page",
  ],
  config: ["--config"],
  structured: [
    "-e", "--execute", "--pinnedpubkey",
  ],
};

// Normalize case, hyphens, and underscores; unlisted commands get no exemption without a role decision.
export const WGETRC_COMMAND_TABLE = {
  path: [
    "ca_certificate", "ca_directory", "certificate", "egd_file", "input", "load_cookies",
    "post_file", "body_file", "private_key", "random_file", "crl_file", "input_metalink",
    "warc_cdx_dedup",
  ],
  writePath: [
    "dir_prefix", "logfile", "output_document", "save_cookies", "hsts_file", "rejected_log",
    "warc_file", "warc_tempdir", "default_page",
  ],
  config: ["choose_config"],
  data: [
    "accept", "reject", "add_hostdir", "ask_password", "auth_no_challenge", "background",
    "backup_converted", "backups", "base", "bind_address", "cache", "certificate_type",
    "check_certificate", "connect_timeout", "content_disposition", "trust_server_names", "continue",
    "convert_links", "cookies", "cut_dirs", "debug", "delete_after", "dirstruct",
    "dns_cache", "dns_timeout", "domains", "dot_bytes", "dot_spacing", "dots_in_line",
    "exclude_directories", "exclude_domains", "follow_ftp", "follow_tags", "force_html", "ftp_password",
    "ftp_proxy", "ftp_user", "glob", "header", "compression", "adjust_extension", "http_keep_alive",
    "http_password", "http_proxy", "http_user", "https_only", "https_proxy", "ignore_case",
    "ignore_length", "ignore_tags", "include_directories", "iri", "inet4_only", "inet6_only",
    "keep_session_cookies", "limit_rate", "local_encoding", "max_redirect", "mirror", "netrc",
    "no_clobber", "no_parent", "no_proxy", "page_requisites", "passive_ftp", "password", "post_data",
    "prefer_family", "private_key_type", "progress", "protocol_directories", "proxy_password",
    "proxy_user", "quiet", "quota", "random_wait", "read_timeout", "reclevel", "recursive", "referer",
    "relative_only", "remote_encoding", "remove_listing", "restrict_file_names", "retr_symlinks",
    "retry_connrefused", "robots", "save_headers", "secure_protocol", "server_response",
    "show_all_dns_entries", "span_hosts", "spider", "strict_comments", "timeout", "timestamping",
    "use_server_timestamps", "tries", "use_proxy", "user", "user_agent", "verbose", "wait",
    "wait_retry", "body_data",
  ],
  structured: [
    "pinnedpubkey",
  ],
} as const;
