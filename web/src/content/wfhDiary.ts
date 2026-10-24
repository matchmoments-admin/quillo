/**
 * Weekly work-from-home diary copy (#787, flag wfh_weekly_diary). Research: docs/research/wfh-records.md.
 * The fixed-rate method needs a record of actual hours kept as you go (PCG 2023/1 para 58), so the copy
 * never calls a pattern a record: hours count only from a confirmed week. General information only, no
 * figures, no verdicts (the tax-advice denylist scans this file).
 */
export const WFH_DIARY_COPY = {
  title: "Your hours diary",
  intro:
    "Set your usual week once. Then each week, confirm it in one tap or change the days that were different. Each confirmation is saved with the date you made it, so the diary is a record kept as you go.",
  patternTitle: "Your usual week",
  patternHelp: "Hours you usually work from home on each day. Leave a day blank if you don't work from home that day.",
  patternSave: "Save my usual week",
  patternChange: "Change usual week",
  thisWeek: "This week",
  latestWeek: "Last week of the year",
  sameAsUsual: "Same as usual",
  adjust: "Change some days",
  confirmAdjusted: "Confirm this week",
  confirmedAt: "Confirmed",
  notYetOpen: "You can confirm a week from its Friday, once the days have happened.",
  replacesTyped:
    "Once you confirm a week, the hours typed above are kept as your hours from before the diary, and the diary adds each confirmed week to them.",
  preDiaryTitle: "Before the diary",
  preDiaryHelp:
    "Hours you worked from home this year before you started the diary, from a record made at the time (a timesheet, work calendar, roster or system log). Say what they come from. Hours from memory are an estimate, so they're kept but not counted.",
  preDiaryNoSource: "say where these came from",
  preDiaryAdd: "Add hours from before the diary",
  preDiaryEdit: "Change",
  preDiarySave: "Save",
  preDiarySourceLabel: "They come from my",
  catchUpTitle: "Weeks not recorded yet",
  catchUpHelp:
    "A week entered more than a week after it ended is marked recorded late, with today's date. Say what you're working from. Hours rebuilt from a record made at the time (a work calendar, timesheet, roster or system log) are counted; keep that record too. Hours from memory are an estimate, so they're kept here but not counted.",
  catchUpSource: "I'm working from my",
  stillOnTime: "still on time",
  lateEdit: "This week ended more than a week ago, so anything you record for it now is marked recorded late, with today's date.",
  historyTitle: "Weeks recorded",
  onTime: "On time",
  late: "Recorded late",
  notCounted: "Not counted (from memory)",
  remove: "Remove",
  removeConfirm: "Remove this week? If you add it again later, it will be recorded late.",
  removeYes: "Remove week",
  keep: "Keep it",
  download: "Download my diary (CSV)",
  keepRecord:
    "Keep the download with your tax records. The ATO asks you to keep records for five years after you lodge. You also need one bill for each running cost the rate covers, such as electricity or internet.",
  generalInfo: "General information only. Check your method and hours with a registered tax agent.",
  ownRecord:
    "You've ticked that you keep your own record of hours, so you don't need this diary. You can still use it if it's easier.",
} as const;

export const WFH_DAY_REASONS = [
  { v: "", label: "From home" },
  { v: "office", label: "Office day" },
  { v: "leave", label: "Leave" },
  { v: "sick", label: "Sick" },
  { v: "public_holiday", label: "Public holiday" },
] as const;

export const WFH_LATE_SOURCES = [
  { v: "calendar", label: "work calendar" },
  { v: "timesheet", label: "timesheets" },
  { v: "roster", label: "roster" },
  { v: "system_log", label: "employer system logs" },
  { v: "memory", label: "memory (kept, not counted)" },
] as const;
