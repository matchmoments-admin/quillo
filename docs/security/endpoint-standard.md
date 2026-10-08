# Endpoint standard (macOS)

> Schedule 2 controls 1(e) (physical access), 2(a) (device encryption), 2(b) (firewalls), 2(d) (end-user
> devices), 5(a) (anti-malware) and 5(c) (application whitelisting). Applies to every device used to
> administer Quillo. Today: one MacBook used by the director. Version 0.1, 2026-10-08. Owner task: **C2**.

Reference: ASD Essential Eight and the cyber.gov.au small-business guides; Apple Platform Security guide.

## 1. Required settings

| # | Control | How (System Settings, macOS 26) | Verify |
|---|---|---|---|
| E1 | **FileVault** full-disk encryption | Privacy & Security → FileVault → On. Store the recovery key in the password manager (not iCloud if you want it out of Apple's reach) | `fdesetup status` → "FileVault is On." |
| E2 | **Automatic updates** (OS, security responses, apps) | General → Software Update → Automatic updates: all on, including "Install Security Responses and system files" | Software Update shows up to date |
| E3 | **Firewall** | Network → Firewall → On; Options → "Block all incoming connections" unless needed; stealth mode on | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` → enabled |
| E4 | **Screen lock** | Lock Screen → require password immediately after screen saver / display off; display off ≤ 5 minutes on battery and power. Use Ctrl-Cmd-Q when stepping away | Manual |
| E5 | **Standard daily account** | Users & Groups → create a separate admin account; make the daily account Standard. Installs and system changes then need the admin password | `id -Gn` for the daily user does not include `admin` |
| E6 | **Password manager** | 1Password, Bitwarden or Apple Passwords with a strong master password and MFA; all Quillo credentials and recovery codes in it | Manual |
| E7 | **Anti-malware** | XProtect and XProtect Remediator are built in and update automatically with E2. Optional: Malwarebytes for Mac (free scanner) monthly scan | `system_profiler SPInstallHistoryDataType | grep -i xprotect` shows recent updates |
| E8 | **Gatekeeper / app control** | Privacy & Security → "Allow applications from: App Store and identified developers". Do not bypass for unsigned apps. Install developer tools (Node, wrangler) via npm/Homebrew from the admin account | `spctl --status` → "assessments enabled" |
| E9 | **Find My Mac** | Apple Account → iCloud → Find My Mac → On (remote lock/erase) | Manual |
| E10 | **Browser** | Keep up to date; Safe Browsing / Fraudulent website warning on; minimal extensions; no password saving in the browser if the password manager is used | Manual |
| E11 | **No CDR data stored locally** | Never export production D1 rows, CDR screenshots or consumer data to the laptop; local dev uses sandbox only | Manual; quarterly check of Downloads/Desktop |
| E12 | **Physical security** | Laptop kept at the owner's home office or on the person; never left unlocked in public; no shoulder-surfing of admin consoles | Manual |
| E13 | **Removable media** | Do not copy company data to USB drives or external disks (no MDM to block it technically) | Manual |

## 2. Verification record

Run at the start and with each quarterly access review. Paste command outputs or tick.

| Date | E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | Checked by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ⬜ | | | | | | | | | | | | | | |

## 3. Mobile phone

The phone holds MFA (authenticator, passkeys) and email. Requirements: current iOS/Android with automatic
updates, a 6+ digit passcode or biometrics, Find My enabled, no jailbreak/root.

## 4. Lost or stolen device

Follow playbook P6 in [incident-response-plan.md](incident-response-plan.md#7-playbooks).
