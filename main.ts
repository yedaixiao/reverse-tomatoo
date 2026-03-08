import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TextComponent,
  WorkspaceLeaf,
  moment,
  normalizePath
} from 'obsidian';

type ThemeMode = 'system' | 'light' | 'dark';
type PomodoroPhase = 'work' | 'break';
type AnalysisRange = 'day' | 'week' | 'month' | 'custom';
type DailyNoteCreateMode = 'template' | 'official-plugin';
type EventQuadrant =
  | 'important-urgent'
  | 'important-not-urgent'
  | 'not-important-urgent'
  | 'not-important-not-urgent';

interface QuadrantMeta {
  label: string;
  shortLabel: string;
  className: string;
}

interface ClockTimerSettings {
  dailyNoteFolder: string;
  dailyNoteFormat: string;
  autoOpenSidebar: boolean;
  preferOfficialDailyNotes: boolean;
  dailyNoteCreateMode: DailyNoteCreateMode;
  dailyNoteTemplatePath: string;
  inboxFilePath: string;
  statsHeading: string;
  pomodoroWorkMinutes: number;
  pomodoroBreakMinutes: number;
  pomodoroAutoStartBreak: boolean;
  hideDecorativeLabels: boolean;
}

interface TimeRange {
  startTimestamp: number;
  endTimestamp: number;
}

interface ActiveTimeRange {
  startTimestamp: number;
  endTimestamp?: number;
}

interface ActiveTimerSession {
  id: string;
  eventName: string;
  startTimestamp: number;
  quadrant: EventQuadrant;
  isPaused: boolean;
  pausedAt: number | null;
  ranges: ActiveTimeRange[];
}

interface CompletedTimerSession {
  id: string;
  eventName: string;
  startTimestamp: number;
  endTimestamp: number;
  quadrant: EventQuadrant;
  durationSeconds: number;
  ranges: TimeRange[];
}

interface SessionSegment {
  sessionId: string;
  eventName: string;
  quadrant: EventQuadrant;
  startTimestamp: number;
  endTimestamp: number;
  durationSeconds: number;
  dateKey: string;
  isActive: boolean;
  sourceSession: CompletedTimerSession | ActiveTimerSession;
}

interface DailyStats {
  totalSeconds: number;
  eventSeconds: Record<string, number>;
}

interface AnalysisBucket {
  dateKey: string;
  label: string;
  totalSeconds: number;
  sessionCount: number;
  dominantQuadrant: EventQuadrant | null;
}

interface AnalysisData {
  range: AnalysisRange;
  label: string;
  shortLabel: string;
  startTimestamp: number;
  endTimestamp: number;
  dateKeys: string[];
  segments: SessionSegment[];
  sessions: CompletedTimerSession[];
  stats: DailyStats;
  buckets: AnalysisBucket[];
}

interface QuickEvent {
  id: string;
  title: string;
  quadrant: EventQuadrant;
  createdAt: number;
  completedAt: number | null;
}

interface InboxItem {
  id: string;
  title: string;
  quadrant: EventQuadrant;
  createdAt: number;
}

interface PomodoroState {
  phase: PomodoroPhase;
  startedAt: number;
  endTimestamp: number;
  eventName: string;
  sessionId: string | null;
  pausedAt?: number | null;
  remainingMs?: number | null;
}

interface DailyNoteConfig {
  folder: string;
  format: string;
  templatePath: string;
  source: 'plugin' | 'official';
}

interface ClockTimerPluginData {
  settings?: Partial<ClockTimerSettings>;
  sessions?: Array<
    CompletedTimerSession & { quadrant?: EventQuadrant; durationSeconds?: number; ranges?: TimeRange[] }
  >;
  sessionsByDate?: Record<
    string,
    Array<
      CompletedTimerSession & { dateKey?: string; quadrant?: EventQuadrant; durationSeconds?: number; ranges?: TimeRange[] }
    >
  >;
  activeSession?: ActiveTimerSession | null;
  preferredTheme?: ThemeMode;
  pomodoroState?: PomodoroState | null;
  quickEventsByDate?: Record<string, QuickEvent[]>;
  inboxItems?: InboxItem[];
}

const VIEW_TYPE_CLOCK_TIMER = 'clock-timer-sidebar-view';
const EVENTS_START_MARKER = '<!-- clock-timer-events:start -->';
const EVENTS_END_MARKER = '<!-- clock-timer-events:end -->';
const RECORDS_START_MARKER = '<!-- clock-timer-records:start -->';
const RECORDS_END_MARKER = '<!-- clock-timer-records:end -->';
const SUMMARY_START_MARKER = '<!-- clock-timer-summary:start -->';
const SUMMARY_END_MARKER = '<!-- clock-timer-summary:end -->';
const INBOX_START_MARKER = '<!-- clock-timer-inbox:start -->';
const INBOX_END_MARKER = '<!-- clock-timer-inbox:end -->';
const DEFAULT_EVENT_QUADRANT: EventQuadrant = 'important-not-urgent';
const QUADRANT_META: Record<EventQuadrant, QuadrantMeta> = {
  'important-urgent': {
    label: '重要而紧急',
    shortLabel: '重+急',
    className: 'quadrant-important-urgent'
  },
  'important-not-urgent': {
    label: '重要而不紧急',
    shortLabel: '重+缓',
    className: 'quadrant-important-not-urgent'
  },
  'not-important-urgent': {
    label: '不重要而紧急',
    shortLabel: '轻+急',
    className: 'quadrant-not-important-urgent'
  },
  'not-important-not-urgent': {
    label: '不重要而不紧急',
    shortLabel: '轻+缓',
    className: 'quadrant-not-important-not-urgent'
  }
};

const DEFAULT_SETTINGS: ClockTimerSettings = {
  dailyNoteFolder: 'Daily',
  dailyNoteFormat: 'YYYY-MM-DD',
  autoOpenSidebar: true,
  preferOfficialDailyNotes: true,
  dailyNoteCreateMode: 'template',
  dailyNoteTemplatePath: '',
  inboxFilePath: 'Inbox/收集箱.md',
  statsHeading: '今日统计汇总',
  pomodoroWorkMinutes: 25,
  pomodoroBreakMinutes: 5,
  pomodoroAutoStartBreak: true,
  hideDecorativeLabels: false
};

export default class ClockTimerPlugin extends Plugin {
  public settings: ClockTimerSettings = DEFAULT_SETTINGS;
  private sessions: CompletedTimerSession[] = [];
  private activeSession: ActiveTimerSession | null = null;
  private quickEventsByDate: Record<string, QuickEvent[]> = {};
  private inboxItems: InboxItem[] = [];
  private preferredTheme: ThemeMode = 'system';
  private pomodoroState: PomodoroState | null = null;
  private pomodoroTickBusy = false;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.registerView(
      VIEW_TYPE_CLOCK_TIMER,
      (leaf: WorkspaceLeaf) => new ClockTimerView(leaf, this)
    );

    this.addRibbonIcon('timer', '打开计时侧栏', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-clock-timer-sidebar',
      name: '打开时钟计时侧栏',
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: 'create-today-daily-note',
      name: '创建今日日志',
      callback: async () => {
        await this.createOrOpenTodayDailyNote(true);
      }
    });

    this.addCommand({
      id: 'open-inbox-file',
      name: '打开收集箱文件',
      callback: async () => {
        await this.createOrOpenInboxFile(true);
      }
    });

    this.addCommand({
      id: 'start-pomodoro-session',
      name: '开始番茄钟工作时段',
      callback: async () => {
        await this.activateView();
        new Notice('请在侧栏输入事件名称后点击“番茄开始”。');
      }
    });

    this.addSettingTab(new ClockTimerSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.refreshAllViews();
      })
    );

    this.registerInterval(
      window.setInterval(() => {
        void this.handlePomodoroTick();
      }, 1000)
    );

    if (this.settings.autoOpenSidebar) {
      this.app.workspace.onLayoutReady(async () => {
        await this.activateView();
      });
    }
  }

  async onunload(): Promise<void> {
    await this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CLOCK_TIMER)
      .reduce(async (previous: Promise<void>, leaf: WorkspaceLeaf) => {
        await previous;
        await leaf.setViewState({ type: 'empty' });
      }, Promise.resolve());
  }

  public async startTimer(
    eventName: string,
    options?: { startTimestamp?: number; suppressNotice?: boolean; quadrant?: EventQuadrant }
  ): Promise<void> {
    const cleanName = eventName.trim();

    if (!cleanName) {
      new Notice('请先输入事件名称。');
      return;
    }

    if (this.activeSession) {
      new Notice('已有计时正在进行中，请先结束当前计时。');
      return;
    }

    const startTimestamp = options?.startTimestamp ?? Date.now();
    this.activeSession = {
      id: `${startTimestamp}`,
      eventName: cleanName,
      startTimestamp,
      quadrant: options?.quadrant ?? DEFAULT_EVENT_QUADRANT,
      isPaused: false,
      pausedAt: null,
      ranges: [{ startTimestamp }]
    };

    await this.syncDailyNotesForDateKeys(this.collectDateKeysForRange(startTimestamp, startTimestamp));
    await this.savePluginData();
    this.refreshAllViews();

    if (!options?.suppressNotice) {
      new Notice(`开始计时：${cleanName}`);
    }
  }

  public async stopTimer(
    options?: { endTimestamp?: number; suppressNotice?: boolean; keepPomodoroState?: boolean }
  ): Promise<void> {
    if (!this.activeSession) {
      new Notice('当前没有正在进行的计时。');
      return;
    }

    const runningSession = this.activeSession;
    const stopTimestamp = options?.endTimestamp ?? Date.now();
    const ranges = runningSession.ranges.map((range) => ({ ...range }));
    const openRange = ranges[ranges.length - 1];
    if (openRange && openRange.endTimestamp === undefined && !runningSession.isPaused) {
      openRange.endTimestamp = Math.max(stopTimestamp, openRange.startTimestamp + 1000);
    }

    const normalizedRanges = ranges.filter(
      (range): range is TimeRange => Number.isFinite(range.startTimestamp) && Number.isFinite(range.endTimestamp)
    );

    if (normalizedRanges.length === 0) {
      this.activeSession = null;
      if (!options?.keepPomodoroState) {
        this.pomodoroState = null;
      }
      await this.savePluginData();
      this.refreshAllViews();
      new Notice('当前计时没有可保存的有效时段。');
      return;
    }

    const sessionStart = normalizedRanges[0].startTimestamp;
    const sessionEnd = normalizedRanges[normalizedRanges.length - 1].endTimestamp;
    const durationSeconds = normalizedRanges.reduce(
      (sum, range) => sum + this.getDurationSeconds(range.startTimestamp, range.endTimestamp),
      0
    );
    const completedSession: CompletedTimerSession = {
      id: runningSession.id,
      eventName: runningSession.eventName,
      startTimestamp: sessionStart,
      endTimestamp: sessionEnd,
      quadrant: runningSession.quadrant,
      durationSeconds,
      ranges: normalizedRanges
    };

    this.sessions.push(completedSession);
    this.sessions.sort((left, right) => left.startTimestamp - right.startTimestamp);
    this.activeSession = null;

    const affectedDateKeys = this.collectDateKeysForRange(
      completedSession.startTimestamp,
      completedSession.endTimestamp
    );
    await this.syncDailyNotesForDateKeys(affectedDateKeys);

    if (!options?.keepPomodoroState) {
      this.pomodoroState = null;
    }

    await this.savePluginData();
    this.refreshAllViews();

    if (!options?.suppressNotice) {
      new Notice(
        `结束计时：${completedSession.eventName}（${this.formatDuration(
          completedSession.durationSeconds
        )}）`
      );
    }
  }

  public async pauseTimer(timestamp = Date.now()): Promise<void> {
    if (!this.activeSession) {
      new Notice('当前没有可以暂停的计时。');
      return;
    }

    if (this.activeSession.isPaused) {
      new Notice('当前计时已经处于暂停状态。');
      return;
    }

    const activeRange = this.activeSession.ranges[this.activeSession.ranges.length - 1];
    if (!activeRange) {
      new Notice('当前计时范围异常，无法暂停。');
      return;
    }

    activeRange.endTimestamp = Math.max(timestamp, activeRange.startTimestamp + 1000);
    this.activeSession.isPaused = true;
    this.activeSession.pausedAt = activeRange.endTimestamp;

    if (this.pomodoroState?.phase === 'work' && this.pomodoroState.sessionId === this.activeSession.id) {
      this.pomodoroState.remainingMs = Math.max(0, this.pomodoroState.endTimestamp - timestamp);
      this.pomodoroState.pausedAt = timestamp;
    }

    await this.syncDailyNotesForDateKeys(
      this.collectDateKeysForRange(activeRange.startTimestamp, activeRange.endTimestamp)
    );
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`已暂停：${this.activeSession.eventName}`);
  }

  public async resumeTimer(timestamp = Date.now()): Promise<void> {
    if (!this.activeSession) {
      new Notice('当前没有可以继续的计时。');
      return;
    }

    if (!this.activeSession.isPaused) {
      new Notice('当前计时没有暂停。');
      return;
    }

    this.activeSession.ranges.push({ startTimestamp: timestamp });
    this.activeSession.isPaused = false;
    this.activeSession.pausedAt = null;

    if (this.pomodoroState?.phase === 'work' && this.pomodoroState.sessionId === this.activeSession.id) {
      const remainingMs = this.pomodoroState.remainingMs ?? Math.max(0, this.pomodoroState.endTimestamp - timestamp);
      this.pomodoroState.endTimestamp = timestamp + remainingMs;
      this.pomodoroState.pausedAt = null;
      this.pomodoroState.remainingMs = null;
    }

    await this.syncDailyNotesForDateKeys(this.collectDateKeysForRange(timestamp, timestamp));
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`继续计时：${this.activeSession.eventName}`);
  }

  public async startPomodoro(eventName: string, quadrant: EventQuadrant): Promise<void> {
    if (this.pomodoroState) {
      new Notice('番茄钟已经在运行中。');
      return;
    }

    const workMinutes = this.normalizePositiveMinutes(this.settings.pomodoroWorkMinutes, 25);
    const startedAt = Date.now();
    await this.startTimer(eventName, {
      startTimestamp: startedAt,
      suppressNotice: true,
      quadrant
    });

    if (!this.activeSession) {
      return;
    }

    this.pomodoroState = {
      phase: 'work',
      startedAt,
      endTimestamp: startedAt + workMinutes * 60000,
      eventName: this.activeSession.eventName,
      sessionId: this.activeSession.id
    };

    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`番茄钟开始：${this.activeSession.eventName}（${workMinutes} 分钟）`);
  }

  public async stopPomodoro(reason = '番茄钟已停止。'): Promise<void> {
    if (!this.pomodoroState) {
      new Notice('当前没有进行中的番茄钟。');
      return;
    }

    const phase = this.pomodoroState.phase;
    this.pomodoroState = null;

    if (phase === 'work' && this.activeSession) {
      await this.stopTimer({ suppressNotice: true, keepPomodoroState: true });
    } else {
      await this.savePluginData();
      this.refreshAllViews();
    }

    new Notice(reason);
  }

  public async skipPomodoroBreak(): Promise<void> {
    if (this.pomodoroState?.phase !== 'break') {
      new Notice('当前不在休息阶段。');
      return;
    }

    this.pomodoroState = null;
    await this.savePluginData();
    this.refreshAllViews();
    new Notice('已跳过休息阶段，可以开始下一轮番茄钟。');
  }

  public getActiveSession(): ActiveTimerSession | null {
    return this.activeSession;
  }

  public getThemePreference(): ThemeMode {
    return this.preferredTheme;
  }

  public getEffectiveTheme(): Exclude<ThemeMode, 'system'> {
    if (this.preferredTheme === 'system') {
      return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
    }

    return this.preferredTheme;
  }

  public async setThemePreference(mode: ThemeMode): Promise<void> {
    this.preferredTheme = mode;
    await this.savePluginData();
    this.refreshAllViews();
  }

  public getTodayStats(): DailyStats {
    return this.getStatsForDate(this.getTodayDateKey());
  }

  public getTodaySegments(): SessionSegment[] {
    return this.getSegmentsForDate(this.getTodayDateKey());
  }

  public getTodaySessions(): CompletedTimerSession[] {
    return this.getSessionsOverlappingDate(this.getTodayDateKey());
  }

  public getAnalysisData(range: AnalysisRange): AnalysisData {
    const window = this.getAnalysisWindow(range);
    return this.buildAnalysisDataFromWindow(window);
  }

  public getCustomAnalysisData(startDateKey: string, endDateKey: string): AnalysisData {
    const window = this.getAnalysisWindowForCustomRange(startDateKey, endDateKey);
    return this.buildAnalysisDataFromWindow(window);
  }

  public async addManualSession(value: {
    eventName: string;
    startTimestamp: number;
    endTimestamp: number;
    quadrant: EventQuadrant;
  }): Promise<void> {
    const eventName = value.eventName.trim();
    if (!eventName) {
      new Notice('事件名称不能为空。');
      return;
    }

    if (!Number.isFinite(value.startTimestamp) || !Number.isFinite(value.endTimestamp)) {
      new Notice('请输入有效的时间段。');
      return;
    }

    if (value.endTimestamp <= value.startTimestamp) {
      new Notice('结束时间必须晚于开始时间。');
      return;
    }

    const session: CompletedTimerSession = {
      id: `${value.startTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
      eventName,
      startTimestamp: value.startTimestamp,
      endTimestamp: value.endTimestamp,
      quadrant: value.quadrant,
      durationSeconds: this.getDurationSeconds(value.startTimestamp, value.endTimestamp),
      ranges: [
        {
          startTimestamp: value.startTimestamp,
          endTimestamp: value.endTimestamp
        }
      ]
    };

    this.sessions.push(session);
    this.sessions.sort((left, right) => left.startTimestamp - right.startTimestamp);

    const affectedDateKeys = this.collectDateKeysForRange(session.startTimestamp, session.endTimestamp);
    await this.syncDailyNotesForDateKeys(affectedDateKeys);
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`已补录事件：${session.eventName}（${this.formatDuration(session.durationSeconds)}）`);
  }

  private buildAnalysisDataFromWindow(
    window: Omit<AnalysisData, 'segments' | 'sessions' | 'stats' | 'buckets'>
  ): AnalysisData {
    const segments = window.dateKeys.flatMap((dateKey) => this.getSegmentsForDate(dateKey));
    const sessions = this.getSessionsOverlappingWindow(window.startTimestamp, window.endTimestamp);
    const buckets = window.dateKeys.map((dateKey) => {
      const bucketSegments = segments.filter((segment) => segment.dateKey === dateKey);
      const quadrantTotals = new Map<EventQuadrant, number>();

      for (const option of this.getQuadrantOptions()) {
        quadrantTotals.set(option.value, 0);
      }

      for (const segment of bucketSegments) {
        quadrantTotals.set(
          segment.quadrant,
          (quadrantTotals.get(segment.quadrant) ?? 0) + segment.durationSeconds
        );
      }

      return {
        dateKey,
        label:
          window.range === 'week'
            ? moment(dateKey, 'YYYY-MM-DD').format('dd')
            : window.range === 'month'
              ? moment(dateKey, 'YYYY-MM-DD').format('DD')
              : moment(dateKey, 'YYYY-MM-DD').format('MM-DD'),
        totalSeconds: bucketSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
        sessionCount: new Set(bucketSegments.map((segment) => segment.sessionId)).size,
        dominantQuadrant:
          [...quadrantTotals.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
      };
    });

    return {
      ...window,
      segments,
      sessions,
      stats: this.buildStatsFromSegments(segments),
      buckets
    };
  }

  public getQuickEventsForDate(dateKey: string): QuickEvent[] {
    return [...(this.quickEventsByDate[dateKey] ?? [])].sort((left, right) => left.createdAt - right.createdAt);
  }

  public getPendingQuickEventsForDate(dateKey: string): QuickEvent[] {
    return this.getQuickEventsForDate(dateKey).filter((item) => item.completedAt === null);
  }

  public getCompletedQuickEventsForDate(dateKey: string): QuickEvent[] {
    return this.getQuickEventsForDate(dateKey)
      .filter((item) => item.completedAt !== null)
      .sort((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0));
  }

  public getInboxItems(): InboxItem[] {
    return [...this.inboxItems].sort((left, right) => left.createdAt - right.createdAt);
  }

  public getPomodoroState(): PomodoroState | null {
    return this.pomodoroState;
  }

  public getPomodoroRemainingMs(): number {
    if (!this.pomodoroState) {
      return 0;
    }

    if (this.pomodoroState.pausedAt) {
      return Math.max(0, this.pomodoroState.remainingMs ?? 0);
    }

    return Math.max(0, this.pomodoroState.endTimestamp - Date.now());
  }

  public getActiveElapsedSeconds(): number {
    if (!this.activeSession) {
      return 0;
    }

    return this.getActiveSessionElapsedSeconds(this.activeSession);
  }

  public getDailyNotePath(targetMoment = moment()): string {
    const config = this.getResolvedDailyNoteConfig();
    const fileName = `${targetMoment.format(config.format)}.md`;

    if (!config.folder) {
      return normalizePath(fileName);
    }

    return normalizePath(`${config.folder}/${fileName}`);
  }

  public getDailyNoteSourceLabel(): string {
    return this.getResolvedDailyNoteConfig().source === 'official'
      ? '官方 Daily Notes'
      : '插件设置';
  }

  public getDailyNoteTemplateLabel(): string {
    const templatePath = this.getResolvedDailyNoteConfig().templatePath.trim();
    return templatePath ? normalizePath(templatePath) : '未设置模板';
  }

  public getDailyNoteCreateMode(): DailyNoteCreateMode {
    return this.settings.dailyNoteCreateMode;
  }

  public shouldHideDecorativeLabels(): boolean {
    return this.settings.hideDecorativeLabels;
  }

  public getQuadrantMeta(quadrant: EventQuadrant): QuadrantMeta {
    return QUADRANT_META[quadrant];
  }

  public getQuadrantOptions(): Array<{ value: EventQuadrant; label: string }> {
    return (Object.entries(QUADRANT_META) as Array<[EventQuadrant, QuadrantMeta]>).map(
      ([value, meta]) => ({ value, label: meta.label })
    );
  }

  public getDefaultQuadrant(): EventQuadrant {
    return DEFAULT_EVENT_QUADRANT;
  }

  public formatDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    const parts: string[] = [];

    if (hours > 0) {
      parts.push(`${hours}小时`);
    }

    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}分钟`);
    }

    parts.push(`${seconds}秒`);
    return parts.join(' ');
  }

  public formatElapsedSince(startTimestamp: number): string {
    return this.formatDuration(this.getDurationSeconds(startTimestamp, Date.now()));
  }

  public formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  public async saveSettings(): Promise<void> {
    await this.savePluginData();
    this.refreshAllViews();
  }

  public async editSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      new Notice('未找到要编辑的计时记录。');
      return;
    }

    new SessionEditModal(this.app, session, async (update) => {
      const oldSession = { ...session };
      session.eventName = update.eventName.trim();
      session.startTimestamp = update.startTimestamp;
      session.endTimestamp = update.endTimestamp;
      session.quadrant = update.quadrant;
      session.ranges = [
        {
          startTimestamp: update.startTimestamp,
          endTimestamp: update.endTimestamp
        }
      ];
      session.durationSeconds = this.getDurationSeconds(update.startTimestamp, update.endTimestamp);
      this.sessions.sort((left, right) => left.startTimestamp - right.startTimestamp);

      const affectedDateKeys = this.getCombinedDateKeys([
        ...this.collectDateKeysForRange(oldSession.startTimestamp, oldSession.endTimestamp),
        ...this.collectDateKeysForRange(session.startTimestamp, session.endTimestamp)
      ]);

      await this.syncDailyNotesForDateKeys(affectedDateKeys);
      await this.savePluginData();
      this.refreshAllViews();
      new Notice('计时记录已更新。');
    }).open();
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      new Notice('未找到要删除的计时记录。');
      return;
    }

    const affectedDateKeys = this.collectDateKeysForRange(session.startTimestamp, session.endTimestamp);
    this.sessions = this.sessions.filter((item) => item.id !== sessionId);

    await this.syncDailyNotesForDateKeys(affectedDateKeys);
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`已删除记录：${session.eventName}`);
  }

  public async createOrOpenTodayDailyNote(openAfterCreate = true): Promise<void> {
    const dateKey = this.getTodayDateKey();
    const file = await this.getOrCreateDailyNote(dateKey);
    await this.syncDailyNoteForDate(dateKey);

    if (openAfterCreate) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }

    new Notice(`今日日志已就绪：${file.path}`);
  }

  public async createOrOpenInboxFile(openAfterCreate = true): Promise<void> {
    const file = await this.getOrCreateInboxFile();
    await this.syncInboxFile();

    if (openAfterCreate) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }

    new Notice(`收集箱已就绪：${file.path}`);
  }

  public async addQuickEvent(
    title: string,
    options?: { dateKey?: string; quadrant?: EventQuadrant; suppressNotice?: boolean }
  ): Promise<void> {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      new Notice('请先输入要添加的事件。');
      return;
    }

    const dateKey = options?.dateKey ?? this.getTodayDateKey();
    const nextItem: QuickEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: cleanTitle,
      quadrant: options?.quadrant ?? DEFAULT_EVENT_QUADRANT,
      createdAt: Date.now(),
      completedAt: null
    };

    this.quickEventsByDate[dateKey] = [...(this.quickEventsByDate[dateKey] ?? []), nextItem];
    await this.syncDailyNoteForDate(dateKey);
    await this.savePluginData();
    this.refreshAllViews();

    if (!options?.suppressNotice) {
      new Notice(`已添加事件：${cleanTitle}`);
    }
  }

  public async deleteQuickEvent(dateKey: string, eventId: string): Promise<void> {
    const current = this.quickEventsByDate[dateKey] ?? [];
    const next = current.filter((item) => item.id !== eventId);

    if (next.length === 0) {
      delete this.quickEventsByDate[dateKey];
    } else {
      this.quickEventsByDate[dateKey] = next;
    }

    await this.syncDailyNoteForDate(dateKey);
    await this.savePluginData();
    this.refreshAllViews();
    new Notice('已删除事件。');
  }

  public async setQuickEventCompleted(
    dateKey: string,
    eventId: string,
    completed: boolean
  ): Promise<void> {
    const current = this.quickEventsByDate[dateKey] ?? [];
    const next = current.map((item) =>
      item.id === eventId
        ? {
            ...item,
            completedAt: completed ? Date.now() : null
          }
        : item
    );

    this.quickEventsByDate[dateKey] = next;
    await this.syncDailyNoteForDate(dateKey);
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(completed ? '事件已完成。' : '事件已恢复为待办。');
  }

  public async addInboxItem(title: string, quadrant: EventQuadrant): Promise<void> {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      new Notice('请先输入待收集事务。');
      return;
    }

    this.inboxItems.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: cleanTitle,
      quadrant,
      createdAt: Date.now()
    });

    await this.syncInboxFile();
    await this.savePluginData();
    this.refreshAllViews();
    new Notice(`已收入收集箱：${cleanTitle}`);
  }

  public async deleteInboxItem(itemId: string): Promise<void> {
    const next = this.inboxItems.filter((item) => item.id !== itemId);
    this.inboxItems = next;
    await this.syncInboxFile();
    await this.savePluginData();
    this.refreshAllViews();
    new Notice('已从收集箱移除。');
  }

  public async assignInboxItem(
    itemId: string,
    dateKey?: string,
    options?: { startNow?: boolean }
  ): Promise<void> {
    const item = this.inboxItems.find((entry) => entry.id === itemId);
    if (!item) {
      new Notice('未找到要分配的收集箱事务。');
      return;
    }

    const targetDateKey = dateKey ?? this.getTodayDateKey();
    const shouldStartNow = options?.startNow === true;
    await this.addQuickEvent(item.title, {
      dateKey: targetDateKey,
      quadrant: item.quadrant,
      suppressNotice: true
    });
    this.inboxItems = this.inboxItems.filter((entry) => entry.id !== itemId);
    await this.syncInboxFile();
    await this.savePluginData();
    this.refreshAllViews();

    if (shouldStartNow) {
      if (targetDateKey !== this.getTodayDateKey()) {
        new Notice(`已分配到 ${targetDateKey}，但“立即开始”仅支持今天。`);
        return;
      }

      if (this.activeSession) {
        new Notice(`已分配到 ${targetDateKey}，但当前已有计时进行中，未自动开始。`);
        return;
      }

      await this.startTimer(item.title, {
        quadrant: item.quadrant,
        suppressNotice: true
      });
      new Notice(`已分配到 ${targetDateKey}，并立即开始计时。`);
      return;
    }

    new Notice(`已分配到 ${targetDateKey}，并从收集箱移除。`);
  }

  private async activateView(): Promise<void> {
    let leaf: WorkspaceLeaf | null =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_CLOCK_TIMER)[0] ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice('无法打开右侧边栏视图。');
        return;
      }

      await leaf.setViewState({
        type: VIEW_TYPE_CLOCK_TIMER,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  private getTodayDateKey(): string {
    return moment().format('YYYY-MM-DD');
  }

  private getStatsForDate(dateKey: string): DailyStats {
    return this.buildStatsFromSegments(this.getSegmentsForDate(dateKey));
  }

  private buildStatsFromSegments(segments: SessionSegment[]): DailyStats {
    const stats: DailyStats = {
      totalSeconds: 0,
      eventSeconds: {}
    };

    for (const segment of segments) {
      stats.totalSeconds += segment.durationSeconds;
      const label = `${this.getQuadrantMeta(segment.quadrant).shortLabel} · ${segment.eventName}`;
      stats.eventSeconds[label] = (stats.eventSeconds[label] ?? 0) + segment.durationSeconds;
    }

    return stats;
  }

  private getSegmentsForDate(dateKey: string): SessionSegment[] {
    const startOfDay = moment(dateKey, 'YYYY-MM-DD').startOf('day').valueOf();
    const endOfDay = moment(dateKey, 'YYYY-MM-DD').add(1, 'day').startOf('day').valueOf();
    const segments: SessionSegment[] = [];

    for (const session of this.sessions) {
      for (const range of session.ranges) {
        const segment = this.createSegmentForRange(
          session,
          range.startTimestamp,
          range.endTimestamp,
          dateKey,
          startOfDay,
          endOfDay,
          false
        );
        if (segment) {
          segments.push(segment);
        }
      }
    }

    if (this.activeSession) {
      for (const range of this.activeSession.ranges) {
        const rangeEnd = range.endTimestamp ?? (this.activeSession.isPaused ? undefined : Date.now());
        if (rangeEnd === undefined) {
          continue;
        }

        const segment = this.createSegmentForRange(
          this.activeSession,
          range.startTimestamp,
          rangeEnd,
          dateKey,
          startOfDay,
          endOfDay,
          range.endTimestamp === undefined && !this.activeSession.isPaused
        );
        if (segment) {
          segments.push(segment);
        }
      }
    }

    segments.sort((left, right) => left.startTimestamp - right.startTimestamp);
    return segments;
  }

  private getSessionsOverlappingDate(dateKey: string): CompletedTimerSession[] {
    const startOfDay = moment(dateKey, 'YYYY-MM-DD').startOf('day').valueOf();
    const endOfDay = moment(dateKey, 'YYYY-MM-DD').add(1, 'day').startOf('day').valueOf();

    return this.getSessionsOverlappingWindow(startOfDay, endOfDay);
  }

  private getSessionsOverlappingWindow(
    startTimestamp: number,
    endTimestamp: number
  ): CompletedTimerSession[] {
    return this.sessions
      .filter((session) =>
        session.ranges.some(
          (range) => range.startTimestamp < endTimestamp && range.endTimestamp > startTimestamp
        )
      )
      .sort((left, right) => left.startTimestamp - right.startTimestamp)
      .map((session) => ({ ...session }));
  }

  private getAnalysisWindow(range: AnalysisRange): Omit<AnalysisData, 'segments' | 'sessions' | 'stats' | 'buckets'> {
    if (range === 'custom') {
      return this.getAnalysisWindowForCustomRange(this.getTodayDateKey(), this.getTodayDateKey());
    }

    const now = moment();
    const start =
      range === 'week'
        ? now.clone().startOf('isoWeek')
        : range === 'month'
          ? now.clone().startOf('month')
          : now.clone().startOf('day');
    const end =
      range === 'week'
        ? start.clone().add(1, 'week')
        : range === 'month'
          ? start.clone().add(1, 'month')
          : start.clone().add(1, 'day');
    const displayEnd = end.clone().subtract(1, 'day');

    return {
      range,
      label:
        range === 'week'
          ? `本周（${start.format('MM/DD')} - ${displayEnd.format('MM/DD')}）`
          : range === 'month'
            ? `本月（${start.format('YYYY年MM月')}）`
            : '今日',
      shortLabel: range === 'week' ? '本周' : range === 'month' ? '本月' : '今日',
      startTimestamp: start.valueOf(),
      endTimestamp: end.valueOf(),
      dateKeys: this.collectDateKeysForRange(start.valueOf(), displayEnd.endOf('day').valueOf())
    };
  }

  private getAnalysisWindowForCustomRange(
    startDateKey: string,
    endDateKey: string
  ): Omit<AnalysisData, 'segments' | 'sessions' | 'stats' | 'buckets'> {
    const rawStart = moment(startDateKey, 'YYYY-MM-DD');
    const rawEnd = moment(endDateKey, 'YYYY-MM-DD');
    const startMoment = rawStart.isAfter(rawEnd) ? rawEnd.clone() : rawStart.clone();
    const endMoment = rawStart.isAfter(rawEnd) ? rawStart.clone() : rawEnd.clone();
    const start = startMoment.startOf('day');
    const end = endMoment.clone().add(1, 'day').startOf('day');

    return {
      range: 'custom',
      label: `自选时段（${start.format('MM/DD')} - ${endMoment.format('MM/DD')}）`,
      shortLabel: '自选时段',
      startTimestamp: start.valueOf(),
      endTimestamp: end.valueOf(),
      dateKeys: this.collectDateKeysForRange(start.valueOf(), endMoment.endOf('day').valueOf())
    };
  }

  private createSegmentForRange(
    session: CompletedTimerSession | ActiveTimerSession,
    actualStart: number,
    actualEnd: number,
    dateKey: string,
    startOfDay: number,
    endOfDay: number,
    isActive: boolean
  ): SessionSegment | null {
    if (actualStart >= endOfDay || actualEnd <= startOfDay) {
      return null;
    }

    const segmentStart = Math.max(actualStart, startOfDay);
    const segmentEnd = Math.min(actualEnd, endOfDay);

    return {
      sessionId: session.id,
      eventName: session.eventName,
      quadrant: session.quadrant,
      startTimestamp: segmentStart,
      endTimestamp: segmentEnd,
      durationSeconds: this.getDurationSeconds(segmentStart, segmentEnd),
      dateKey,
      isActive,
      sourceSession: session
    };
  }

  private getDurationSeconds(startTimestamp: number, endTimestamp: number): number {
    return Math.max(1, Math.round((endTimestamp - startTimestamp) / 1000));
  }

  private getActiveSessionElapsedSeconds(session: ActiveTimerSession): number {
    return session.ranges.reduce((sum, range) => {
      const endTimestamp = range.endTimestamp ?? (session.isPaused ? undefined : Date.now());
      if (endTimestamp === undefined) {
        return sum;
      }

      return sum + this.getDurationSeconds(range.startTimestamp, endTimestamp);
    }, 0);
  }

  private collectDateKeysForRange(startTimestamp: number, endTimestamp: number): string[] {
    const keys: string[] = [];
    let cursor = moment(startTimestamp).startOf('day');
    const last = moment(endTimestamp).startOf('day');

    while (cursor.valueOf() <= last.valueOf()) {
      keys.push(cursor.format('YYYY-MM-DD'));
      cursor = cursor.clone().add(1, 'day');
    }

    return keys;
  }

  private getCombinedDateKeys(dateKeys: string[]): string[] {
    return [...new Set(dateKeys)].sort();
  }

  private getResolvedDailyNoteConfig(): DailyNoteConfig {
    if (this.settings.preferOfficialDailyNotes) {
      const officialConfig = this.getOfficialDailyNotesConfig();
      if (officialConfig) {
        return officialConfig;
      }
    }

    return {
      folder: this.settings.dailyNoteFolder.trim(),
      format: this.settings.dailyNoteFormat.trim() || DEFAULT_SETTINGS.dailyNoteFormat,
      templatePath: this.settings.dailyNoteTemplatePath.trim(),
      source: 'plugin'
    };
  }

  private getOfficialDailyNotesConfig(): DailyNoteConfig | null {
    const internalPlugins = (this.app as App & {
      internalPlugins?: {
        getPluginById?: (id: string) => unknown;
        plugins?: Record<string, unknown>;
      };
    }).internalPlugins;

    const pluginCandidate =
      internalPlugins?.getPluginById?.('daily-notes') ?? internalPlugins?.plugins?.['daily-notes'];
    const pluginObject = pluginCandidate as {
      enabled?: boolean;
      instance?: {
        options?: {
          folder?: string;
          format?: string;
          template?: string;
          templatePath?: string;
          templateFile?: string;
          templateLocation?: string;
        };
      };
      options?: {
        folder?: string;
        format?: string;
        template?: string;
        templatePath?: string;
        templateFile?: string;
        templateLocation?: string;
      };
    } | null;

    const options = pluginObject?.instance?.options ?? pluginObject?.options;
    const format = options?.format?.trim();
    const templatePath =
      options?.template?.trim() ??
      options?.templatePath?.trim() ??
      options?.templateFile?.trim() ??
      options?.templateLocation?.trim() ??
      '';

    if (!format) {
      return null;
    }

    return {
      folder: options?.folder?.trim() ?? '',
      format,
      templatePath,
      source: 'official'
    };
  }

  private async loadPluginData(): Promise<void> {
    const data = (await this.loadData()) as ClockTimerPluginData | null;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(data?.settings ?? {})
    };
    this.sessions = this.migrateSessions(data);
    this.activeSession = data?.activeSession
      ? {
          ...data.activeSession,
          quadrant: data.activeSession.quadrant ?? DEFAULT_EVENT_QUADRANT,
          isPaused: data.activeSession.isPaused ?? false,
          pausedAt: data.activeSession.pausedAt ?? null,
          ranges:
            data.activeSession.ranges?.length
              ? data.activeSession.ranges.map((range) => ({ ...range }))
              : [{ startTimestamp: data.activeSession.startTimestamp }]
        }
      : null;
    this.preferredTheme = data?.preferredTheme ?? 'system';
    this.pomodoroState = data?.pomodoroState ?? null;
    this.quickEventsByDate = Object.fromEntries(
      Object.entries(data?.quickEventsByDate ?? {}).map(([dateKey, items]) => [
        dateKey,
        (items ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          quadrant: item.quadrant ?? DEFAULT_EVENT_QUADRANT,
          createdAt: item.createdAt ?? Date.now(),
          completedAt: item.completedAt ?? null
        }))
      ])
    );
    this.inboxItems = (data?.inboxItems ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      quadrant: item.quadrant ?? DEFAULT_EVENT_QUADRANT,
      createdAt: item.createdAt ?? Date.now()
    }));
  }

  private migrateSessions(data: ClockTimerPluginData | null): CompletedTimerSession[] {
    if (data?.sessions?.length) {
      return data.sessions
        .map((session) => ({
          ...session,
          quadrant: session.quadrant ?? DEFAULT_EVENT_QUADRANT,
          ranges:
            session.ranges?.length
              ? session.ranges.map((range) => ({ ...range }))
              : [{ startTimestamp: session.startTimestamp, endTimestamp: session.endTimestamp }],
          durationSeconds:
            session.durationSeconds ?? this.getDurationSeconds(session.startTimestamp, session.endTimestamp)
        }))
        .sort((left, right) => left.startTimestamp - right.startTimestamp);
    }

    const legacy = data?.sessionsByDate ?? {};
    const deduped = new Map<string, CompletedTimerSession>();

    for (const sessionList of Object.values(legacy)) {
      for (const session of sessionList) {
        deduped.set(session.id, {
          id: session.id,
          eventName: session.eventName,
          startTimestamp: session.startTimestamp,
          endTimestamp: session.endTimestamp,
          quadrant: session.quadrant ?? DEFAULT_EVENT_QUADRANT,
          durationSeconds:
            session.durationSeconds ?? this.getDurationSeconds(session.startTimestamp, session.endTimestamp),
          ranges:
            session.ranges?.length
              ? session.ranges.map((range) => ({ ...range }))
              : [{ startTimestamp: session.startTimestamp, endTimestamp: session.endTimestamp }]
        });
      }
    }

    return [...deduped.values()].sort((left, right) => left.startTimestamp - right.startTimestamp);
  }

  private async savePluginData(): Promise<void> {
    const data: ClockTimerPluginData = {
      settings: this.settings,
      sessions: this.sessions,
      activeSession: this.activeSession,
      preferredTheme: this.preferredTheme,
      pomodoroState: this.pomodoroState,
      quickEventsByDate: this.quickEventsByDate,
      inboxItems: this.inboxItems
    };

    await this.saveData(data);
  }

  private refreshAllViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CLOCK_TIMER)) {
      const view = leaf.view;
      if (view instanceof ClockTimerView) {
        view.refresh();
      }
    }
  }

  private async handlePomodoroTick(): Promise<void> {
    if (!this.pomodoroState || this.pomodoroTickBusy) {
      return;
    }

    if (this.pomodoroState.pausedAt) {
      return;
    }

    if (Date.now() < this.pomodoroState.endTimestamp) {
      return;
    }

    this.pomodoroTickBusy = true;
    try {
      if (this.pomodoroState.phase === 'work') {
        const finishedState = this.pomodoroState;

        if (this.activeSession?.id === finishedState.sessionId) {
          await this.stopTimer({
            endTimestamp: finishedState.endTimestamp,
            suppressNotice: true,
            keepPomodoroState: true
          });
        }

        if (this.settings.pomodoroAutoStartBreak) {
          const breakMinutes = this.normalizePositiveMinutes(this.settings.pomodoroBreakMinutes, 5);
          this.pomodoroState = {
            phase: 'break',
            startedAt: finishedState.endTimestamp,
            endTimestamp: finishedState.endTimestamp + breakMinutes * 60000,
            eventName: finishedState.eventName,
            sessionId: null
          };
          await this.savePluginData();
          this.refreshAllViews();
          new Notice(`番茄工作时段完成，开始休息 ${breakMinutes} 分钟。`);
        } else {
          this.pomodoroState = null;
          await this.savePluginData();
          this.refreshAllViews();
          new Notice('番茄工作时段完成！');
        }
      } else {
        this.pomodoroState = null;
        await this.savePluginData();
        this.refreshAllViews();
        new Notice('休息时间结束，准备开始下一轮吧。');
      }
    } finally {
      this.pomodoroTickBusy = false;
    }
  }

  private normalizePositiveMinutes(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }

    return Math.max(1, Math.round(value));
  }

  private async syncDailyNotesForDateKeys(dateKeys: string[]): Promise<void> {
    const uniqueKeys = this.getCombinedDateKeys(dateKeys);

    for (const dateKey of uniqueKeys) {
      await this.syncDailyNoteForDate(dateKey);
    }
  }

  private async syncDailyNoteForDate(dateKey: string): Promise<void> {
    const file = await this.getOrCreateDailyNote(dateKey);
    const eventsBlock = this.renderEventsBlock(dateKey);
    const recordsBlock = this.renderRecordsBlock(dateKey);
    const summaryBlock = this.renderSummaryBlock(dateKey);

    await this.app.vault.process(file, (content: string) => {
      let nextContent = this.upsertManagedBlock(
        content,
        EVENTS_START_MARKER,
        EVENTS_END_MARKER,
        eventsBlock
      );
      nextContent = this.upsertManagedBlock(
        nextContent,
        RECORDS_START_MARKER,
        RECORDS_END_MARKER,
        recordsBlock
      );
      nextContent = this.upsertManagedBlock(
        nextContent,
        SUMMARY_START_MARKER,
        SUMMARY_END_MARKER,
        summaryBlock
      );
      return this.ensureTrailingNewline(nextContent);
    });
  }

  private async syncInboxFile(): Promise<void> {
    const file = await this.getOrCreateInboxFile();
    const inboxBlock = this.renderInboxBlock();

    await this.app.vault.process(file, (content: string) => {
      const nextContent = this.upsertManagedBlock(
        content,
        INBOX_START_MARKER,
        INBOX_END_MARKER,
        inboxBlock
      );
      return this.ensureTrailingNewline(nextContent);
    });
  }

  private renderEventsBlock(dateKey: string): string {
    const pendingEvents = this.getPendingQuickEventsForDate(dateKey);
    const completedEvents = this.getCompletedQuickEventsForDate(dateKey);
    const pendingLines = pendingEvents.length
      ? pendingEvents.map(
          (event) => `- [ ] ${event.title} [${this.getQuadrantMeta(event.quadrant).label}]`
        )
      : ['- 暂无待办事件。'];
    const completedLines = completedEvents.length
      ? completedEvents.map(
          (event) =>
            `- [x] ${event.title} [${this.getQuadrantMeta(event.quadrant).label}]（完成于 ${moment(
              event.completedAt ?? event.createdAt
            ).format('HH:mm:ss')}）`
        )
      : ['- 暂无已完成事件。'];

    return [
      EVENTS_START_MARKER,
      '## 今日待办事件',
      '',
      '### 待办',
      ...pendingLines,
      '',
      '### 已完成',
      ...completedLines,
      EVENTS_END_MARKER
    ].join('\n');
  }

  private renderRecordsBlock(dateKey: string): string {
    const segments = this.getSegmentsForDate(dateKey);
    const lines = segments.length
      ? segments.map((segment) => this.renderRecordLine(segment))
      : ['- 今天还没有计时记录。'];

    return [
      RECORDS_START_MARKER,
      '## 时钟计时记录',
      ...lines,
      RECORDS_END_MARKER
    ].join('\n');
  }

  private renderSummaryBlock(dateKey: string): string {
    const stats = this.getStatsForDate(dateKey);
    const eventEntries = Object.entries(stats.eventSeconds).sort((left, right) => right[1] - left[1]);
    const topEvent = eventEntries[0];

    const lines = [
      SUMMARY_START_MARKER,
      `## ${this.settings.statsHeading.trim() || DEFAULT_SETTINGS.statsHeading}`,
      `- 总时长：${this.formatDuration(stats.totalSeconds)}`,
      `- 事件数量：${eventEntries.length}`,
      `- 最长事件：${topEvent ? `${topEvent[0]}（${this.formatDuration(topEvent[1])}）` : '暂无'}`,
      '',
      '### 各事件耗时'
    ];

    if (eventEntries.length === 0) {
      lines.push('- 今天还没有可汇总的数据。');
    } else {
      for (const [eventName, seconds] of eventEntries) {
        lines.push(`- ${eventName}：${this.formatDuration(seconds)}`);
      }
    }

    lines.push(SUMMARY_END_MARKER);
    return lines.join('\n');
  }

  private renderInboxBlock(): string {
    const items = this.getInboxItems();
    const lines = items.length
      ? items.map(
          (item) => `- [ ] ${item.title} [${this.getQuadrantMeta(item.quadrant).label}]`
        )
      : ['- 收集箱目前是空的。'];

    return [
      INBOX_START_MARKER,
      '# 收集箱',
      '',
      '> 用来先接住杂乱事务、临时想法、待处理事项；完成分配后会自动从这里移除。',
      '',
      ...lines,
      INBOX_END_MARKER
    ].join('\n');
  }

  private renderRecordLine(segment: SessionSegment): string {
    const startText = this.formatTimeForSegment(segment.startTimestamp, segment.dateKey, false);
    const endText = segment.isActive
      ? '进行中'
      : this.formatTimeForSegment(segment.endTimestamp, segment.dateKey, true);
    const suffix = segment.isActive ? '（进行中）' : `（${this.formatDuration(segment.durationSeconds)}）`;
    return `- ${startText} - ${endText} ${segment.eventName} [${this.getQuadrantMeta(segment.quadrant).label}] ${suffix}`;
  }

  private formatTimeForSegment(timestamp: number, dateKey: string, isEnd: boolean): string {
    const target = moment(timestamp);
    if (
      isEnd &&
      target.format('YYYY-MM-DD') !== dateKey &&
      target.clone().startOf('day').valueOf() === timestamp
    ) {
      return '24:00:00';
    }

    return target.format('HH:mm:ss');
  }

  private upsertManagedBlock(
    content: string,
    startMarker: string,
    endMarker: string,
    block: string
  ): string {
    const pattern = new RegExp(`${this.escapeRegExp(startMarker)}[\\s\\S]*?${this.escapeRegExp(endMarker)}`, 'm');
    const trimmed = content.trimEnd();

    if (pattern.test(trimmed)) {
      return trimmed.replace(pattern, block);
    }

    return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private ensureTrailingNewline(content: string): string {
    return content.endsWith('\n') ? content : `${content}\n`;
  }

  private async getOrCreateDailyNote(dateKey: string): Promise<TFile> {
    const targetMoment = moment(dateKey, 'YYYY-MM-DD');
    const path = this.getDailyNotePath(targetMoment);
    const existingFile = this.app.vault.getAbstractFileByPath(path);

    if (existingFile instanceof TFile) {
      return existingFile;
    }

    if (existingFile) {
      throw new Error(`路径 ${path} 已存在，但不是文件。`);
    }

    const folder = this.getResolvedDailyNoteConfig().folder;
    if (folder) {
      await this.ensureFolderExists(folder);
    }

    if (
      dateKey === this.getTodayDateKey() &&
      this.settings.dailyNoteCreateMode === 'official-plugin'
    ) {
      const officialFile = await this.tryCreateTodayDailyNoteViaOfficialPlugin();
      if (officialFile) {
        return officialFile;
      }

      new Notice('未能通过 Daily Notes 插件创建今日日志，已回退到模板/默认创建。');
    }

    const initialContent = await this.buildDailyNoteInitialContent(targetMoment);
    return await this.app.vault.create(path, initialContent);
  }

  private async tryCreateTodayDailyNoteViaOfficialPlugin(): Promise<TFile | null> {
    const todayPath = this.getDailyNotePath(moment());
    const existingFile = this.app.vault.getAbstractFileByPath(todayPath);
    if (existingFile instanceof TFile) {
      return existingFile;
    }

    const internalPlugins = (this.app as App & {
      internalPlugins?: {
        getPluginById?: (id: string) => unknown;
        plugins?: Record<string, unknown>;
      };
      commands?: {
        executeCommandById?: (id: string) => Promise<boolean> | boolean;
      };
    }).internalPlugins;

    const pluginCandidate =
      internalPlugins?.getPluginById?.('daily-notes') ?? internalPlugins?.plugins?.['daily-notes'];
    const pluginObject = pluginCandidate as {
      enabled?: boolean;
      instance?: {
        createDailyNote?: () => Promise<TFile | null> | TFile | null;
        createAndOpenDailyNote?: () => Promise<TFile | null> | TFile | null;
      };
    } | null;

    if (!pluginObject?.enabled) {
      return null;
    }

    const createFns = [
      pluginObject.instance?.createDailyNote,
      pluginObject.instance?.createAndOpenDailyNote
    ].filter((fn): fn is NonNullable<typeof fn> => typeof fn === 'function');

    for (const fn of createFns) {
      try {
        const result = await fn.call(pluginObject.instance);
        if (result instanceof TFile) {
          return result;
        }

        const created = this.app.vault.getAbstractFileByPath(todayPath);
        if (created instanceof TFile) {
          return created;
        }
      } catch {
        // ignore and try the next strategy
      }
    }

    const commands = (this.app as App & {
      commands?: {
        executeCommandById?: (id: string) => Promise<boolean> | boolean;
      };
    }).commands;
    const candidateCommandIds = ['daily-notes', 'daily-notes:open-today'];

    for (const commandId of candidateCommandIds) {
      try {
        const executed = await commands?.executeCommandById?.(commandId);
        if (executed === false) {
          continue;
        }

        const created = this.app.vault.getAbstractFileByPath(todayPath);
        if (created instanceof TFile) {
          return created;
        }
      } catch {
        // ignore and try the next strategy
      }
    }

    return null;
  }

  private getInboxFilePath(): string {
    return normalizePath(this.settings.inboxFilePath.trim() || DEFAULT_SETTINGS.inboxFilePath);
  }

  private async getOrCreateInboxFile(): Promise<TFile> {
    const path = this.getInboxFilePath();
    const existingFile = this.app.vault.getAbstractFileByPath(path);

    if (existingFile instanceof TFile) {
      return existingFile;
    }

    if (existingFile) {
      throw new Error(`路径 ${path} 已存在，但不是文件。`);
    }

    const normalized = normalizePath(path);
    const slashIndex = normalized.lastIndexOf('/');
    if (slashIndex > -1) {
      await this.ensureFolderExists(normalized.slice(0, slashIndex));
    }

    return await this.app.vault.create(path, `${this.renderInboxBlock()}\n`);
  }

  private async buildDailyNoteInitialContent(targetMoment: moment.Moment): Promise<string> {
    const templatePath = this.getResolvedDailyNoteConfig().templatePath.trim();

    if (!templatePath) {
      return `# ${targetMoment.format('YYYY-MM-DD')}\n\n`;
    }

    const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(templatePath));
    if (!(templateFile instanceof TFile)) {
      new Notice(`日志模板未找到：${templatePath}`);
      return `# ${targetMoment.format('YYYY-MM-DD')}\n\n`;
    }

    const templateContent = await this.app.vault.read(templateFile);
    const renderedContent = this.renderTemplateContent(templateContent, targetMoment);
    return `${this.ensureTrailingNewline(renderedContent.trimEnd())}\n`;
  }

  private renderTemplateContent(template: string, targetMoment: moment.Moment): string {
    let rendered = template;

    const replaceWithMoment = (
      input: string,
      token: 'date' | 'time' | 'datetime' | 'yesterday' | 'tomorrow' | 'title'
    ): string => {
      return input.replace(
        new RegExp(`{{\\s*${token}(?::([^}]+))?\\s*}}`, 'g'),
        (_fullMatch, customFormat?: string) => {
          const format = customFormat?.trim();

          switch (token) {
            case 'date':
              return targetMoment.format(format || 'YYYY-MM-DD');
            case 'time':
              return targetMoment.format(format || 'HH:mm:ss');
            case 'datetime':
              return targetMoment.format(format || 'YYYY-MM-DD HH:mm:ss');
            case 'yesterday':
              return targetMoment.clone().subtract(1, 'day').format(format || 'YYYY-MM-DD');
            case 'tomorrow':
              return targetMoment.clone().add(1, 'day').format(format || 'YYYY-MM-DD');
            case 'title':
              return targetMoment.format(format || 'YYYY-MM-DD');
            default:
              return '';
          }
        }
      );
    };

    rendered = replaceWithMoment(rendered, 'date');
    rendered = replaceWithMoment(rendered, 'time');
    rendered = replaceWithMoment(rendered, 'datetime');
    rendered = replaceWithMoment(rendered, 'yesterday');
    rendered = replaceWithMoment(rendered, 'tomorrow');
    rendered = replaceWithMoment(rendered, 'title');

    return rendered;
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      return;
    }

    const parts = normalized.split('/');
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}

class ClockTimerView extends ItemView {
  private plugin: ClockTimerPlugin;
  private rootEl!: HTMLDivElement;
  private overviewTitleEl!: HTMLHeadingElement;
  private statsTitleEl!: HTMLHeadingElement;
  private chartTitleEl!: HTMLHeadingElement;
  private chartDescriptionEl!: HTMLDivElement;
  private sessionTitleEl!: HTMLHeadingElement;
  private statusEl!: HTMLDivElement;
  private totalEl!: HTMLDivElement;
  private summaryMetaEl!: HTMLDivElement;
  private summaryInsightEl!: HTMLDivElement;
  private notePathEl!: HTMLDivElement;
  private quickEventTitleEl!: HTMLHeadingElement;
  private quickEventListEl!: HTMLDivElement;
  private inboxTitleEl!: HTMLHeadingElement;
  private inboxMetaEl!: HTMLDivElement;
  private inboxListEl!: HTMLDivElement;
  private eventListEl!: HTMLDivElement;
  private statsHintEl!: HTMLDivElement;
  private sessionListEl!: HTMLDivElement;
  private chartEl!: HTMLDivElement;
  private chartSummaryEl!: HTMLDivElement;
  private pomodoroEl!: HTMLDivElement;
  private noteActionsEl!: HTMLDivElement;
  private eventInputEl!: HTMLInputElement;
  private quadrantSelectEl!: HTMLSelectElement;
  private inboxInputEl!: HTMLInputElement;
  private inboxQuadrantSelectEl!: HTMLSelectElement;
  private quadrantFilterEl!: HTMLSelectElement;
  private eventFilterEl!: HTMLSelectElement;
  private customRangeWrapEl!: HTMLDivElement;
  private customRangeStartEl!: HTMLInputElement;
  private customRangeEndEl!: HTMLInputElement;
  private selectedRange: AnalysisRange = 'day';
  private selectedQuadrantFilter: EventQuadrant | 'all' = 'all';
  private selectedEventFilter = 'all';
  private customRangeStartDateKey = moment().clone().subtract(6, 'days').format('YYYY-MM-DD');
  private customRangeEndDateKey = moment().format('YYYY-MM-DD');
  private selectedDateKey: string | null = null;
  private selectedSessionId: string | null = null;
  private themeButtons = new Map<ThemeMode, HTMLButtonElement>();
  private rangeButtons = new Map<AnalysisRange, HTMLButtonElement>();
  private currentSegments: SessionSegment[] = [];
  private currentSessions: CompletedTimerSession[] = [];
  private currentAnalysisData: AnalysisData | null = null;
  private timerHandle: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClockTimerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CLOCK_TIMER;
  }

  getDisplayText(): string {
    return '时钟计时';
  }

  getIcon(): string {
    return 'timer';
  }

  async onOpen(): Promise<void> {
    this.buildView();
    this.refresh();

    this.timerHandle = window.setInterval(() => {
      this.refresh();
    }, 1000);
  }

  async onClose(): Promise<void> {
    if (this.timerHandle !== null) {
      window.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  public refresh(): void {
    if (!this.rootEl) {
      return;
    }

    const now = moment();
    const effectiveTheme = this.plugin.getEffectiveTheme();
    const preferredTheme = this.plugin.getThemePreference();
    const activeSession = this.plugin.getActiveSession();
    const pomodoroState = this.plugin.getPomodoroState();
    const [customStartDateKey, customEndDateKey] = this.getCustomRangeBounds();
    const analysisData =
      this.selectedRange === 'custom'
        ? this.plugin.getCustomAnalysisData(customStartDateKey, customEndDateKey)
        : this.plugin.getAnalysisData(this.selectedRange);
    if (
      this.selectedDateKey &&
      (analysisData.range === 'day' || !analysisData.dateKeys.includes(this.selectedDateKey))
    ) {
      this.selectedDateKey = null;
    }

    const detailSegments = this.getDetailSegments(analysisData);
    const quickEventDateKey = this.getQuickEventTargetDateKey();
    const quickEvents = this.plugin.getQuickEventsForDate(quickEventDateKey);
    const inboxItems = this.plugin.getInboxItems();
    const segmentsForEventOptions = this.applySegmentFilters(
      detailSegments,
      this.selectedQuadrantFilter,
      'all'
    );

    this.syncEventFilterOptions(segmentsForEventOptions);

    const segments = this.applySegmentFilters(
      detailSegments,
      this.selectedQuadrantFilter,
      this.selectedEventFilter
    );
    const allowedSessionIds = new Set(segments.map((segment) => segment.sessionId));
    const sessions = analysisData.sessions.filter((session) => allowedSessionIds.has(session.id));
    const stats = this.buildStatsFromSegments(segments);

    this.currentAnalysisData = analysisData;
    this.currentSegments = segments;
    this.currentSessions = sessions;

    if (
      this.selectedSessionId &&
      !sessions.some((session) => session.id === this.selectedSessionId) &&
      !segments.some((segment) => segment.sessionId === this.selectedSessionId)
    ) {
      this.selectedSessionId = null;
    }

    this.rootEl.classList.remove('clock-theme-light', 'clock-theme-dark');
    this.rootEl.classList.add(
      effectiveTheme === 'dark' ? 'clock-theme-dark' : 'clock-theme-light'
    );
    this.rootEl.classList.toggle(
      'clock-hide-decorative-labels',
      this.plugin.shouldHideDecorativeLabels()
    );

    this.rangeButtons.forEach((button, range) => {
      button.classList.toggle('is-active', range === this.selectedRange);
    });
    this.customRangeWrapEl.toggleClass('is-visible', this.selectedRange === 'custom');
    this.customRangeStartEl.value = customStartDateKey;
    this.customRangeEndEl.value = customEndDateKey;

    const detailLabel = this.selectedDateKey
      ? `${moment(this.selectedDateKey, 'YYYY-MM-DD').format('MM月DD日')}详情`
      : analysisData.shortLabel;

    this.overviewTitleEl.setText(`${detailLabel}总时长`);
    this.statsTitleEl.setText(`${detailLabel}事件耗时统计`);
    this.chartTitleEl.setText(
      analysisData.range === 'day' ? '当天时间分布图' : `${analysisData.shortLabel}趋势分析图`
    );
    this.chartDescriptionEl.setText(
      analysisData.range === 'day'
        ? '按四象限分层展示；在窄屏上保留横向滑动，避免信息挤成一锅粥。'
        : this.selectedDateKey
          ? `已锁定 ${moment(this.selectedDateKey, 'YYYY-MM-DD').format('MM月DD日')} 详情；再次点击柱子可取消。`
          : `按天查看 ${analysisData.label} 的投入走势，点击某天柱子可联动切到当日详情。`
    );
    this.sessionTitleEl.setText(`${detailLabel}记录（支持编辑 / 删除）`);
    this.quickEventTitleEl.setText(
      this.selectedDateKey
        ? `${moment(quickEventDateKey, 'YYYY-MM-DD').format('MM月DD日')}待办事件`
        : '今日待办事件'
    );
    this.inboxTitleEl.setText('收集箱（杂乱事务 / 待处理事务）');
    this.inboxMetaEl.setText(
      `当前 ${inboxItems.length} 项 · 默认分配到 ${
        quickEventDateKey === moment().format('YYYY-MM-DD')
          ? '今天'
          : moment(quickEventDateKey, 'YYYY-MM-DD').format('MM/DD')
      }`
    );
    this.totalEl.setText(this.plugin.formatDuration(stats.totalSeconds));
    const statEntries = Object.entries(stats.eventSeconds).sort((left, right) => right[1] - left[1]);
    const topEntry = statEntries[0];
    const filterSummary = this.getFilterSummaryText();
    this.summaryMetaEl.empty();
    this.summaryMetaEl.createDiv({
      cls: 'clock-summary-pill',
      text: `记录 ${sessions.length} 条`
    });
    this.summaryMetaEl.createDiv({
      cls: 'clock-summary-pill',
      text: `事件 ${statEntries.length} 类`
    });
    this.summaryMetaEl.createDiv({
      cls: 'clock-summary-pill accent',
      text: analysisData.label
    });
    if (this.selectedDateKey) {
      this.summaryMetaEl.createDiv({
        cls: 'clock-summary-pill accent',
        text: `详情：${moment(this.selectedDateKey, 'YYYY-MM-DD').format('MM/DD')}`
      });
    }
    if (filterSummary) {
      this.summaryMetaEl.createDiv({
        cls: 'clock-summary-pill',
        text: filterSummary
      });
    }
    this.summaryMetaEl.createDiv({
      cls: 'clock-summary-pill accent',
      text: activeSession ? '专注进行中' : '等待开始'
    });
    this.summaryInsightEl.setText(
      topEntry
        ? `${detailLabel}主线：${topEntry[0]} · ${this.plugin.formatDuration(topEntry[1])}`
        : `${detailLabel}还没有形成稳定主线，先开一段专注把节奏拉起来。`
    );
    this.notePathEl.setText(
      `当日日记：${this.plugin.getDailyNotePath(now)} · 来源：${this.plugin.getDailyNoteSourceLabel()} · 模板：${this.plugin.getDailyNoteTemplateLabel()}`
    );
    this.statsHintEl.setText(
      topEntry
        ? `${detailLabel}当前占比最高的是 ${topEntry[0]}，继续保持这条主线会更像一个完整工作流。`
        : `开始后这里会显示 ${detailLabel}最重要的时间投入方向。`
    );

    this.themeButtons.forEach((button, mode) => {
      button.classList.toggle('is-active', mode === preferredTheme);
    });

    if (activeSession) {
      this.statusEl.setText(
        `进行中：${activeSession.eventName} · 已计时 ${this.plugin.formatDuration(
          this.plugin.getActiveElapsedSeconds()
        )}${activeSession.isPaused ? ' · 已暂停' : ''}`
      );
      this.eventInputEl.value = activeSession.eventName;
      this.eventInputEl.disabled = true;
      this.quadrantSelectEl.value = activeSession.quadrant;
      this.quadrantSelectEl.disabled = true;
    } else {
      this.statusEl.setText('当前没有进行中的计时，输入事件名称后开始。');
      this.eventInputEl.disabled = false;
      this.quadrantSelectEl.disabled = false;
      if (!this.quadrantSelectEl.value) {
        this.quadrantSelectEl.value = this.plugin.getDefaultQuadrant();
      }
    }

    this.renderPomodoro(pomodoroState);
    this.renderQuickEvents(quickEvents, quickEventDateKey);
    this.renderInboxItems(inboxItems, quickEventDateKey);
    this.renderEventStats(stats.eventSeconds, analysisData.shortLabel);
    this.renderChartSummary(segments, analysisData);
    this.renderTimelineChart(segments, analysisData);
    this.renderSessionList(sessions);
  }

  private buildView(): void {
    this.contentEl.empty();
    this.contentEl.addClass('clock-timer-view');

    this.rootEl = this.contentEl.createDiv({ cls: 'clock-timer-root' });

    const headerEl = this.rootEl.createDiv({ cls: 'clock-card clock-header-card' });
    const titleWrap = headerEl.createDiv({ cls: 'clock-header-copy' });
    titleWrap.createDiv({ cls: 'clock-eyebrow', text: 'Focus cockpit' });
    titleWrap.createEl('h2', { text: '时钟计时' });
    titleWrap.createEl('p', {
      text: '打开就能开始、补录、回看。'
    });

    const themeWrap = headerEl.createDiv({ cls: 'clock-theme-toggle' });
    this.createThemeButton(themeWrap, 'system', '跟随系统');
    this.createThemeButton(themeWrap, 'light', '白天');
    this.createThemeButton(themeWrap, 'dark', '黑夜');

    const contentEl = this.rootEl.createDiv({ cls: 'clock-vertical-stack' });

    const controlEl = contentEl.createDiv({ cls: 'clock-card clock-module-card clock-control-card' });
    controlEl.createDiv({ cls: 'clock-section-kicker', text: '开始一次专注' });
    controlEl.createDiv({
      cls: 'clock-section-description',
      text: '输入事件后可立即开始、补录，或先加入待办。'
    });
    controlEl.createEl('label', {
      text: '事件名称',
      cls: 'clock-field-label'
    });

    this.eventInputEl = controlEl.createEl('input', {
      type: 'text',
      cls: 'clock-event-input',
      placeholder: '例如：写作、阅读、做题、开会'
    });

    controlEl.createEl('label', {
      text: '事件分类（重要度 / 紧急度）',
      cls: 'clock-field-label'
    });

    this.quadrantSelectEl = controlEl.createEl('select', {
      cls: 'clock-category-select'
    });
    for (const option of this.plugin.getQuadrantOptions()) {
      this.quadrantSelectEl.createEl('option', {
        value: option.value,
        text: option.label
      });
    }
    this.quadrantSelectEl.value = this.plugin.getDefaultQuadrant();

    this.eventInputEl.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      const activeSession = this.plugin.getActiveSession();
      if (activeSession && !activeSession.isPaused) {
        await this.plugin.stopTimer();
      } else if (activeSession?.isPaused) {
        await this.plugin.resumeTimer();
      } else {
        await this.plugin.startTimer(this.eventInputEl.value, {
          quadrant: this.quadrantSelectEl.value as EventQuadrant
        });
      }
    });

    const actionEl = controlEl.createDiv({ cls: 'clock-actions' });
    const startButton = actionEl.createEl('button', {
      text: '开始计时',
      cls: 'mod-cta'
    });
    startButton.addClass('clock-button-primary');
    startButton.addEventListener('click', async () => {
      await this.plugin.startTimer(this.eventInputEl.value, {
        quadrant: this.quadrantSelectEl.value as EventQuadrant
      });
    });

    const stopButton = actionEl.createEl('button', {
      text: '结束计时'
    });
    stopButton.addClass('clock-button-secondary');
    stopButton.addEventListener('click', async () => {
      await this.plugin.stopTimer();
    });

    const pauseButton = actionEl.createEl('button', {
      text: '暂停 / 继续'
    });
    pauseButton.addClass('clock-button-secondary');
    pauseButton.addEventListener('click', async () => {
      const activeSession = this.plugin.getActiveSession();
      if (!activeSession) {
        new Notice('当前没有可暂停的计时。');
        return;
      }

      if (activeSession.isPaused) {
        await this.plugin.resumeTimer();
      } else {
        await this.plugin.pauseTimer();
      }
    });

    const pomodoroButton = actionEl.createEl('button', {
      text: '番茄开始'
    });
    pomodoroButton.addClass('clock-button-ghost');
    pomodoroButton.addEventListener('click', async () => {
      await this.plugin.startPomodoro(
        this.eventInputEl.value,
        this.quadrantSelectEl.value as EventQuadrant
      );
    });

    const manualAddButton = actionEl.createEl('button', {
      text: '直接补录'
    });
    manualAddButton.addClass('clock-button-secondary');
    manualAddButton.addEventListener('click', async () => {
      new ManualSessionModal(
        this.app,
        {
          eventName: this.eventInputEl.value,
          quadrant: this.quadrantSelectEl.value as EventQuadrant,
          dateKey: this.getQuickEventTargetDateKey()
        },
        async (value) => {
          await this.plugin.addManualSession(value);
          this.eventInputEl.value = '';
        }
      ).open();
    });

    const quickAddButton = actionEl.createEl('button', {
      text: '加入待办'
    });
    quickAddButton.addClass('clock-button-ghost');
    quickAddButton.addEventListener('click', async () => {
      await this.plugin.addQuickEvent(this.eventInputEl.value, {
        dateKey: this.getQuickEventTargetDateKey(),
        quadrant: this.quadrantSelectEl.value as EventQuadrant
      });
      this.eventInputEl.value = '';
    });

    this.statusEl = controlEl.createDiv({ cls: 'clock-status' });
    this.pomodoroEl = controlEl.createDiv({ cls: 'clock-pomodoro-panel' });

    const quickEventCard = contentEl.createDiv({
      cls: 'clock-card clock-module-card clock-quick-events-card'
    });
    quickEventCard.createDiv({ cls: 'clock-section-kicker', text: 'Quick add' });
    this.quickEventTitleEl = quickEventCard.createEl('h3', { text: '今日待办事件' });
    quickEventCard.createDiv({
      cls: 'clock-section-description',
      text: '不想立刻开计时，也可以直接丢进今日日志的事件区块里，后面再开始。'
    });
    this.quickEventListEl = quickEventCard.createDiv({
      cls: 'clock-event-list clock-scroll-panel clock-quick-event-scroll'
    });

    const inboxCard = contentEl.createDiv({ cls: 'clock-card clock-module-card clock-inbox-card' });
    inboxCard.createDiv({ cls: 'clock-section-kicker', text: 'Inbox' });
    this.inboxTitleEl = inboxCard.createEl('h3', { text: '收集箱（杂乱事务 / 待处理事务）' });
    inboxCard.createDiv({
      cls: 'clock-section-description',
      text: '先收集，再分配；分配到某天后会自动从收集箱删除。'
    });
    this.inboxInputEl = inboxCard.createEl('input', {
      type: 'text',
      cls: 'clock-event-input',
      placeholder: '例如：回消息、补材料、跟进报销、临时想法'
    });
    this.inboxQuadrantSelectEl = inboxCard.createEl('select', {
      cls: 'clock-category-select'
    });
    for (const option of this.plugin.getQuadrantOptions()) {
      this.inboxQuadrantSelectEl.createEl('option', {
        value: option.value,
        text: option.label
      });
    }
    this.inboxQuadrantSelectEl.value = this.plugin.getDefaultQuadrant();

    const inboxActionsEl = inboxCard.createDiv({ cls: 'clock-mini-actions' });
    const collectButton = inboxActionsEl.createEl('button', { text: '收入收集箱' });
    collectButton.addClass('clock-button-secondary');
    collectButton.addEventListener('click', async () => {
      await this.plugin.addInboxItem(
        this.inboxInputEl.value,
        this.inboxQuadrantSelectEl.value as EventQuadrant
      );
      this.inboxInputEl.value = '';
    });

    const openInboxButton = inboxActionsEl.createEl('button', { text: '打开收集箱文件' });
    openInboxButton.addClass('clock-button-ghost');
    openInboxButton.addEventListener('click', async () => {
      await this.plugin.createOrOpenInboxFile(true);
    });

    this.inboxMetaEl = inboxCard.createDiv({
      cls: 'clock-subtle-meta',
      text: '当前 0 项 · 默认分配到今天'
    });
    this.inboxListEl = inboxCard.createDiv({
      cls: 'clock-event-list clock-scroll-panel clock-inbox-scroll'
    });

    const filterCard = contentEl.createDiv({ cls: 'clock-card clock-module-card clock-filter-card' });
    filterCard.createDiv({ cls: 'clock-section-kicker', text: '范围与筛选' });
    filterCard.createEl('h3', { text: '分析面板筛选器' });
    filterCard.createDiv({
      cls: 'clock-section-description',
      text: '切换今日 / 本周 / 本月 / 自选时段，并按象限或事件过滤统计、图表和记录。'
    });

    const rangeToggleEl = filterCard.createDiv({ cls: 'clock-range-toggle' });
    this.createRangeButton(rangeToggleEl, 'day', '今日');
    this.createRangeButton(rangeToggleEl, 'week', '本周');
    this.createRangeButton(rangeToggleEl, 'month', '本月');
    this.createRangeButton(rangeToggleEl, 'custom', '自选');

    this.customRangeWrapEl = filterCard.createDiv({ cls: 'clock-custom-range-row' });
    const customStartField = this.customRangeWrapEl.createDiv({ cls: 'clock-filter-field' });
    customStartField.createEl('label', { text: '开始日期', cls: 'clock-field-label' });
    this.customRangeStartEl = customStartField.createEl('input', {
      type: 'date',
      cls: 'clock-date-input'
    });
    this.customRangeStartEl.value = this.customRangeStartDateKey;
    this.customRangeStartEl.addEventListener('change', () => {
      this.customRangeStartDateKey = this.customRangeStartEl.value || this.customRangeStartDateKey;
      this.selectedDateKey = null;
      this.selectedSessionId = null;
      if (this.selectedRange === 'custom') {
        this.refresh();
      }
    });

    const customEndField = this.customRangeWrapEl.createDiv({ cls: 'clock-filter-field' });
    customEndField.createEl('label', { text: '结束日期', cls: 'clock-field-label' });
    this.customRangeEndEl = customEndField.createEl('input', {
      type: 'date',
      cls: 'clock-date-input'
    });
    this.customRangeEndEl.value = this.customRangeEndDateKey;
    this.customRangeEndEl.addEventListener('change', () => {
      this.customRangeEndDateKey = this.customRangeEndEl.value || this.customRangeEndDateKey;
      this.selectedDateKey = null;
      this.selectedSessionId = null;
      if (this.selectedRange === 'custom') {
        this.refresh();
      }
    });

    const filterGridEl = filterCard.createDiv({ cls: 'clock-filter-grid' });
    const quadrantFieldEl = filterGridEl.createDiv({ cls: 'clock-filter-field' });
    quadrantFieldEl.createEl('label', { text: '象限筛选', cls: 'clock-field-label' });
    this.quadrantFilterEl = quadrantFieldEl.createEl('select', { cls: 'clock-category-select' });
    this.quadrantFilterEl.createEl('option', { value: 'all', text: '全部象限' });
    for (const option of this.plugin.getQuadrantOptions()) {
      this.quadrantFilterEl.createEl('option', {
        value: option.value,
        text: option.label
      });
    }
    this.quadrantFilterEl.addEventListener('change', () => {
      this.selectedQuadrantFilter = this.quadrantFilterEl.value as EventQuadrant | 'all';
      this.selectedSessionId = null;
      this.refresh();
    });

    const eventFieldEl = filterGridEl.createDiv({ cls: 'clock-filter-field' });
    eventFieldEl.createEl('label', { text: '事件筛选', cls: 'clock-field-label' });
    this.eventFilterEl = eventFieldEl.createEl('select', { cls: 'clock-category-select' });
    this.eventFilterEl.createEl('option', { value: 'all', text: '全部事件' });
    this.eventFilterEl.addEventListener('change', () => {
      this.selectedEventFilter = this.eventFilterEl.value;
      this.selectedSessionId = null;
      this.refresh();
    });

    const filterActionsEl = filterCard.createDiv({ cls: 'clock-mini-actions' });
    const resetFiltersButton = filterActionsEl.createEl('button', { text: '清空筛选' });
    resetFiltersButton.addClass('clock-button-secondary');
    resetFiltersButton.addEventListener('click', () => {
      this.selectedQuadrantFilter = 'all';
      this.selectedEventFilter = 'all';
      this.selectedDateKey = null;
      this.selectedSessionId = null;
      this.quadrantFilterEl.value = 'all';
      this.eventFilterEl.value = 'all';
      this.refresh();
    });

    const summaryEl = contentEl.createDiv({ cls: 'clock-grid clock-summary-shell' });

    const totalCard = summaryEl.createDiv({ cls: 'clock-card clock-module-card clock-summary-card' });
    totalCard.createDiv({ cls: 'clock-section-kicker', text: '今日概览' });
    this.overviewTitleEl = totalCard.createEl('h3', { text: '今日总时长' });
    this.totalEl = totalCard.createDiv({ cls: 'clock-total' });
    this.summaryMetaEl = totalCard.createDiv({ cls: 'clock-summary-pills' });
    this.summaryInsightEl = totalCard.createDiv({ cls: 'clock-summary-insight' });
    this.notePathEl = totalCard.createDiv({ cls: 'clock-note-path' });
    this.noteActionsEl = totalCard.createDiv({ cls: 'clock-mini-actions' });
    const createLogButton = this.noteActionsEl.createEl('button', { text: '创建今日日志' });
    createLogButton.addClass('clock-button-secondary');
    createLogButton.addEventListener('click', async () => {
      await this.plugin.createOrOpenTodayDailyNote(true);
    });

    const statsCard = summaryEl.createDiv({ cls: 'clock-card clock-module-card clock-summary-card' });
    statsCard.createDiv({ cls: 'clock-section-kicker', text: '专注占比' });
    this.statsTitleEl = statsCard.createEl('h3', { text: '事件耗时统计' });
    this.statsHintEl = statsCard.createDiv({ cls: 'clock-stats-hint' });
    this.eventListEl = statsCard.createDiv({ cls: 'clock-event-list clock-scroll-panel clock-stats-scroll' });

    const chartCard = contentEl.createDiv({ cls: 'clock-card clock-module-card clock-chart-card' });
    chartCard.createDiv({ cls: 'clock-section-kicker', text: '时间热区' });
    this.chartTitleEl = chartCard.createEl('h3', { text: '当天时间分布图' });
    this.chartDescriptionEl = chartCard.createDiv({
      cls: 'clock-section-description compact',
      text: '按四象限分层展示；在窄屏上保留横向滑动，避免信息挤成一锅粥。'
    });
    this.chartSummaryEl = chartCard.createDiv({ cls: 'clock-chart-summary' });
    this.chartEl = chartCard.createDiv({ cls: 'clock-chart clock-scroll-panel clock-chart-scroll-panel' });

    const sessionCard = contentEl.createDiv({ cls: 'clock-card clock-module-card clock-session-card' });
    sessionCard.createDiv({ cls: 'clock-section-kicker', text: '可回溯记录' });
    this.sessionTitleEl = sessionCard.createEl('h3', { text: '今日记录（支持编辑 / 删除）' });
    this.sessionListEl = sessionCard.createDiv({
      cls: 'clock-session-list clock-scroll-panel clock-session-scroll'
    });
  }

  private createThemeButton(
    container: HTMLDivElement,
    mode: ThemeMode,
    label: string
  ): void {
    const button = container.createEl('button', { text: label });
    button.addEventListener('click', async () => {
      await this.plugin.setThemePreference(mode);
    });
    this.themeButtons.set(mode, button);
  }

  private createRangeButton(
    container: HTMLDivElement,
    range: AnalysisRange,
    label: string
  ): void {
    const button = container.createEl('button', { text: label });
    button.addEventListener('click', () => {
      this.selectedRange = range;
      this.selectedDateKey = null;
      this.selectedSessionId = null;
      if (range === 'custom') {
        const [startDateKey, endDateKey] = this.getCustomRangeBounds();
        this.customRangeStartDateKey = startDateKey;
        this.customRangeEndDateKey = endDateKey;
      }
      this.refresh();
    });
    this.rangeButtons.set(range, button);
  }

  private renderQuickEvents(events: QuickEvent[], dateKey: string): void {
    this.quickEventListEl.empty();

    if (events.length === 0) {
      this.quickEventListEl.createDiv({
        cls: 'clock-empty-state compact',
        text: `${moment(dateKey, 'YYYY-MM-DD').format('MM月DD日')}还没有直接添加的事件。`
      });
      return;
    }

    const pendingEvents = events.filter((event) => event.completedAt === null);
    const completedEvents = events.filter((event) => event.completedAt !== null);

    this.quickEventListEl.createDiv({ cls: 'clock-list-section-title', text: '待办' });
    if (pendingEvents.length === 0) {
      this.quickEventListEl.createDiv({
        cls: 'clock-empty-state compact',
        text: '当前没有待办事件。'
      });
    }

    for (const event of pendingEvents) {
      const itemEl = this.quickEventListEl.createDiv({ cls: 'clock-stat-item clock-quick-event-item' });
      const mainEl = itemEl.createDiv({ cls: 'clock-stat-main' });
      const metaEl = mainEl.createDiv({ cls: 'clock-session-meta' });
      metaEl.createDiv({
        cls: `clock-session-dot ${this.plugin.getQuadrantMeta(event.quadrant).className}`
      });
      metaEl.createDiv({
        cls: `clock-quadrant-badge ${this.plugin.getQuadrantMeta(event.quadrant).className}`,
        text: this.plugin.getQuadrantMeta(event.quadrant).label
      });
      mainEl.createDiv({ cls: 'clock-session-name', text: event.title });
      mainEl.createDiv({
        cls: 'clock-session-time',
        text: `添加于 ${moment(event.createdAt).format('MM-DD HH:mm:ss')}`
      });

      const actionsEl = itemEl.createDiv({ cls: 'clock-mini-actions' });
      const startButton = actionsEl.createEl('button', { text: '开始' });
      startButton.addEventListener('click', async () => {
        await this.plugin.startTimer(event.title, { quadrant: event.quadrant });
      });

      const completeButton = actionsEl.createEl('button', { text: '完成' });
      completeButton.addClass('clock-button-primary');
      completeButton.addEventListener('click', async () => {
        await this.plugin.setQuickEventCompleted(dateKey, event.id, true);
      });

      const deleteButton = actionsEl.createEl('button', { text: '删除' });
      deleteButton.addClass('mod-warning');
      deleteButton.addEventListener('click', async () => {
        await this.plugin.deleteQuickEvent(dateKey, event.id);
      });
    }

    this.quickEventListEl.createDiv({ cls: 'clock-list-section-title', text: '已完成' });
    if (completedEvents.length === 0) {
      this.quickEventListEl.createDiv({
        cls: 'clock-empty-state compact',
        text: '完成后会自动移动到这里。'
      });
      return;
    }

    for (const event of completedEvents) {
      const itemEl = this.quickEventListEl.createDiv({
        cls: 'clock-stat-item clock-quick-event-item is-completed'
      });
      const mainEl = itemEl.createDiv({ cls: 'clock-stat-main' });
      const metaEl = mainEl.createDiv({ cls: 'clock-session-meta' });
      metaEl.createDiv({
        cls: `clock-session-dot ${this.plugin.getQuadrantMeta(event.quadrant).className}`
      });
      metaEl.createDiv({
        cls: `clock-quadrant-badge ${this.plugin.getQuadrantMeta(event.quadrant).className}`,
        text: this.plugin.getQuadrantMeta(event.quadrant).label
      });
      mainEl.createDiv({ cls: 'clock-session-name', text: event.title });
      mainEl.createDiv({
        cls: 'clock-session-time',
        text: `完成于 ${moment(event.completedAt).format('MM-DD HH:mm:ss')}`
      });

      const actionsEl = itemEl.createDiv({ cls: 'clock-mini-actions' });
      const restoreButton = actionsEl.createEl('button', { text: '恢复待办' });
      restoreButton.addEventListener('click', async () => {
        await this.plugin.setQuickEventCompleted(dateKey, event.id, false);
      });

      const deleteButton = actionsEl.createEl('button', { text: '删除' });
      deleteButton.addClass('mod-warning');
      deleteButton.addEventListener('click', async () => {
        await this.plugin.deleteQuickEvent(dateKey, event.id);
      });
    }
  }

  private renderInboxItems(items: InboxItem[], targetDateKey: string): void {
    this.inboxListEl.empty();

    if (items.length === 0) {
      this.inboxListEl.createDiv({
        cls: 'clock-empty-state compact',
        text: '收集箱当前为空，脑海里的碎事务可以先丢进来。'
      });
      return;
    }

    const targetLabel = moment(targetDateKey, 'YYYY-MM-DD').format('MM/DD');
    const quickAssignLabel =
      targetDateKey === moment().format('YYYY-MM-DD') ? '分配到今天' : `分配到 ${targetLabel}`;

    for (const item of [...items].sort((left, right) => right.createdAt - left.createdAt)) {
      const itemEl = this.inboxListEl.createDiv({ cls: 'clock-stat-item clock-inbox-item' });
      const mainEl = itemEl.createDiv({ cls: 'clock-stat-main clock-inbox-main' });
      const headerEl = mainEl.createDiv({ cls: 'clock-inbox-item-header' });
      headerEl.createDiv({ cls: 'clock-session-name', text: item.title });
      headerEl.createDiv({
        cls: `clock-quadrant-badge ${this.plugin.getQuadrantMeta(item.quadrant).className}`,
        text: this.plugin.getQuadrantMeta(item.quadrant).label
      });

      const metaEl = mainEl.createDiv({ cls: 'clock-inbox-meta-row' });
      metaEl.createDiv({
        cls: `clock-session-dot ${this.plugin.getQuadrantMeta(item.quadrant).className}`
      });
      metaEl.createDiv({
        cls: 'clock-meta-chip',
        text: `收入 ${moment(item.createdAt).format('MM-DD HH:mm:ss')}`
      });
      metaEl.createDiv({
        cls: 'clock-meta-chip accent',
        text: `建议投递 ${targetLabel}`
      });

      const actionsEl = itemEl.createDiv({ cls: 'clock-mini-actions clock-inbox-actions' });
      const quickAssignButton = actionsEl.createEl('button', { text: quickAssignLabel });
      quickAssignButton.addClass('clock-button-primary');
      quickAssignButton.addEventListener('click', async () => {
        await this.plugin.assignInboxItem(item.id, targetDateKey);
      });

      const assignButton = actionsEl.createEl('button', { text: '指定日期' });
      assignButton.addClass('clock-button-secondary');
      assignButton.addEventListener('click', async () => {
        new AssignInboxItemModal(this.app, item.title, targetDateKey, async (dateKey, startNow) => {
          await this.plugin.assignInboxItem(item.id, dateKey, { startNow });
        }).open();
      });

      const deleteButton = actionsEl.createEl('button', { text: '删除' });
      deleteButton.addClass('mod-warning');
      deleteButton.addEventListener('click', async () => {
        await this.plugin.deleteInboxItem(item.id);
      });
    }
  }

  private renderPomodoro(pomodoroState: PomodoroState | null): void {
    this.pomodoroEl.empty();

    if (!pomodoroState) {
      this.pomodoroEl.createDiv({
        cls: 'clock-empty-state compact',
        text: '番茄钟未启动：点击“番茄开始”即可按工作 / 休息节奏运行。'
      });
      return;
    }

    const stateEl = this.pomodoroEl.createDiv({ cls: 'clock-pomodoro-state' });
    stateEl.createDiv({
      cls: 'clock-pomodoro-title',
      text:
        pomodoroState.phase === 'work'
          ? `🍅 ${pomodoroState.pausedAt ? '已暂停' : '专注中'}：${pomodoroState.eventName}`
          : '☕ 休息中'
    });
    stateEl.createDiv({
      cls: 'clock-pomodoro-timer',
      text: this.plugin.formatCountdown(this.plugin.getPomodoroRemainingMs())
    });

    const actionsEl = this.pomodoroEl.createDiv({ cls: 'clock-mini-actions' });
    if (pomodoroState.phase === 'break') {
      const skipButton = actionsEl.createEl('button', { text: '跳过休息' });
      skipButton.addEventListener('click', async () => {
        await this.plugin.skipPomodoroBreak();
      });
    }

    const stopButton = actionsEl.createEl('button', { text: '停止番茄钟' });
    stopButton.addEventListener('click', async () => {
      await this.plugin.stopPomodoro();
    });
  }

  private renderChartSummary(segments: SessionSegment[], analysisData: AnalysisData): void {
    this.chartSummaryEl.empty();
    const filteredBuckets = this.buildFilteredBuckets(analysisData.buckets, segments);

    if (segments.length === 0) {
      this.chartSummaryEl.createDiv({
        cls: 'clock-chart-summary-empty',
        text: `${analysisData.shortLabel}在当前筛选条件下还没有可分析的数据。`
      });
      return;
    }

    const totalSegments = segments.length;
    const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const longestSegment = [...segments].sort((left, right) => right.durationSeconds - left.durationSeconds)[0];
    const quadrantTotals = new Map<EventQuadrant, number>();
    const periodBuckets = new Map<string, number>([
      ['夜间 00-06', 0],
      ['上午 06-12', 0],
      ['下午 12-18', 0],
      ['晚间 18-24', 0]
    ]);

    for (const option of this.plugin.getQuadrantOptions()) {
      quadrantTotals.set(option.value, 0);
    }

    for (const segment of segments) {
      quadrantTotals.set(segment.quadrant, (quadrantTotals.get(segment.quadrant) ?? 0) + segment.durationSeconds);

      const dayStart = moment(segment.dateKey, 'YYYY-MM-DD').startOf('day');
      const periods = [
        { label: '夜间 00-06', start: dayStart.clone(), end: dayStart.clone().add(6, 'hours') },
        { label: '上午 06-12', start: dayStart.clone().add(6, 'hours'), end: dayStart.clone().add(12, 'hours') },
        { label: '下午 12-18', start: dayStart.clone().add(12, 'hours'), end: dayStart.clone().add(18, 'hours') },
        { label: '晚间 18-24', start: dayStart.clone().add(18, 'hours'), end: dayStart.clone().add(1, 'day') }
      ];

      for (const period of periods) {
        const overlapMs = Math.max(
          0,
          Math.min(segment.endTimestamp, period.end.valueOf()) -
            Math.max(segment.startTimestamp, period.start.valueOf())
        );

        if (overlapMs > 0) {
          const overlapSeconds = Math.max(1, Math.round(overlapMs / 1000));
          periodBuckets.set(period.label, (periodBuckets.get(period.label) ?? 0) + overlapSeconds);
        }
      }
    }

    const dominantQuadrant = [...quadrantTotals.entries()].sort((left, right) => right[1] - left[1])[0];
    const deepFocusCount = segments.filter((segment) => segment.durationSeconds >= 25 * 60).length;
    const deepFocusSeconds = segments
      .filter((segment) => segment.durationSeconds >= 25 * 60)
      .reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const deepFocusRate = totalSeconds > 0 ? Math.round((deepFocusSeconds / totalSeconds) * 100) : 0;
    const bestPeriod = [...periodBuckets.entries()].sort((left, right) => right[1] - left[1])[0];
    const sortedQuadrants = [...quadrantTotals.entries()].sort((left, right) => right[1] - left[1]);
    const activeDays = filteredBuckets.filter((bucket) => bucket.totalSeconds > 0).length;
    const averageDaySeconds = activeDays > 0 ? Math.round(totalSeconds / activeDays) : 0;
    const bestDay = [...filteredBuckets].sort((left, right) => right.totalSeconds - left.totalSeconds)[0];

    const cards =
      analysisData.range === 'day'
        ? [
            {
              label: '专注段数',
              value: `${totalSegments}`,
              note: deepFocusCount > 0 ? `${deepFocusCount} 段达到番茄标准` : '还没有达到 25 分钟的深度专注段'
            },
            {
              label: '深度专注率',
              value: `${deepFocusRate}%`,
              note:
                deepFocusSeconds > 0
                  ? `${this.plugin.formatDuration(deepFocusSeconds)} 来自 25 分钟以上专注段`
                  : '先完成一段 25 分钟专注，面板会更亮眼'
            },
            {
              label: '最佳时段',
              value: bestPeriod?.[0] ?? '--',
              note: bestPeriod ? `${this.plugin.formatDuration(bestPeriod[1])} 的有效投入集中在这个时间窗` : '暂无数据'
            },
            {
              label: '主导象限',
              value: dominantQuadrant ? this.plugin.getQuadrantMeta(dominantQuadrant[0]).shortLabel : '--',
              note: dominantQuadrant
                ? `${this.plugin.getQuadrantMeta(dominantQuadrant[0]).label} · ${this.plugin.formatDuration(dominantQuadrant[1])}`
                : '暂无数据'
            },
            {
              label: '最长连续专注',
              value: this.plugin.formatDuration(longestSegment.durationSeconds),
              note: `${longestSegment.eventName} · ${moment(longestSegment.startTimestamp).format('HH:mm')} - ${moment(
                longestSegment.endTimestamp
              ).format('HH:mm')}`
            }
          ]
        : [
            {
              label: '专注段数',
              value: `${totalSegments}`,
              note: `其中 ${deepFocusCount} 段达到 25 分钟以上的深度专注`
            },
            {
              label: '活跃天数',
              value: `${activeDays}/${analysisData.dateKeys.length}`,
              note: activeDays > 0 ? `${analysisData.shortLabel}里有记录的天数占比 ${Math.round((activeDays / analysisData.dateKeys.length) * 100)}%` : '这一周期还没有活跃记录'
            },
            {
              label: '日均投入',
              value: this.plugin.formatDuration(averageDaySeconds),
              note: activeDays > 0 ? `按有记录的 ${activeDays} 天计算平均投入` : '暂无可平均的数据'
            },
            {
              label: '主导象限',
              value: dominantQuadrant ? this.plugin.getQuadrantMeta(dominantQuadrant[0]).shortLabel : '--',
              note: dominantQuadrant
                ? `${this.plugin.getQuadrantMeta(dominantQuadrant[0]).label} · ${this.plugin.formatDuration(dominantQuadrant[1])}`
                : '暂无数据'
            },
            {
              label: '最长连续专注',
              value: this.plugin.formatDuration(longestSegment.durationSeconds),
              note: `${moment(longestSegment.startTimestamp).format('MM-DD HH:mm')} · ${longestSegment.eventName}`
            }
          ];

    const metricGridEl = this.chartSummaryEl.createDiv({ cls: 'clock-chart-summary-grid' });

    for (const card of cards) {
      const cardEl = metricGridEl.createDiv({ cls: 'clock-metric-card' });
      cardEl.createDiv({ cls: 'clock-metric-label', text: card.label });
      cardEl.createDiv({ cls: 'clock-metric-value', text: card.value });
      cardEl.createDiv({ cls: 'clock-metric-note', text: card.note });
    }

    const breakdownEl = this.chartSummaryEl.createDiv({ cls: 'clock-analysis-block' });
    breakdownEl.createDiv({ cls: 'clock-analysis-section-title', text: '四象限占比' });
    const rowsEl = breakdownEl.createDiv({ cls: 'clock-analysis-rows' });

    for (const [quadrant, seconds] of sortedQuadrants) {
      const meta = this.plugin.getQuadrantMeta(quadrant);
      const percent = totalSeconds > 0 ? Math.round((seconds / totalSeconds) * 100) : 0;
      const rowEl = rowsEl.createDiv({ cls: 'clock-analysis-row' });
      const labelEl = rowEl.createDiv({ cls: 'clock-analysis-row-label' });
      labelEl.createDiv({ cls: `clock-analysis-dot ${meta.className}` });
      labelEl.createSpan({ text: meta.label });

      rowEl.createDiv({
        cls: 'clock-analysis-row-value',
        text: `${this.plugin.formatDuration(seconds)} · ${percent}%`
      });

      const trackEl = rowEl.createDiv({ cls: 'clock-analysis-bar-track' });
      const fillEl = trackEl.createDiv({ cls: `clock-analysis-bar-fill ${meta.className}` });
      fillEl.style.width = `${Math.max(6, percent)}%`;
    }

    const insightEl = this.chartSummaryEl.createDiv({ cls: 'clock-analysis-block insight' });
    insightEl.createDiv({ cls: 'clock-analysis-section-title', text: `${analysisData.shortLabel}洞察` });
    const insightListEl = insightEl.createEl('ul', { cls: 'clock-analysis-list' });

    insightListEl.createEl('li', {
      text: `最稳定的一段专注是 “${longestSegment.eventName}”，持续 ${this.plugin.formatDuration(longestSegment.durationSeconds)}。`
    });
    if (dominantQuadrant) {
      insightListEl.createEl('li', {
        text: `时间主要投在「${this.plugin.getQuadrantMeta(dominantQuadrant[0]).label}」，说明你今天的节奏更偏这个决策象限。`
      });
    }
    if (bestPeriod) {
      insightListEl.createEl('li', {
        text: `最佳状态出现在 ${bestPeriod[0]}，这段时间累计了 ${this.plugin.formatDuration(bestPeriod[1])} 的有效投入。`
      });
    }
    if (analysisData.range !== 'day' && bestDay && bestDay.totalSeconds > 0) {
      insightListEl.createEl('li', {
        text: `高产日出现在 ${moment(bestDay.dateKey, 'YYYY-MM-DD').format('MM-DD')}，当天累计 ${this.plugin.formatDuration(bestDay.totalSeconds)}。`
      });
    }
  }

  private renderEventStats(eventSeconds: Record<string, number>, rangeLabel: string): void {
    this.eventListEl.empty();

    const entries = Object.entries(eventSeconds).sort((left, right) => right[1] - left[1]);
    if (entries.length === 0) {
      this.eventListEl.createDiv({
        cls: 'clock-empty-state',
        text: `${rangeLabel}在当前筛选下还没有事件数据，先开始一段专注吧。`
      });
      return;
    }

    const maxSeconds = Math.max(...entries.map(([, seconds]) => seconds), 1);
    const totalSeconds = entries.reduce((sum, [, seconds]) => sum + seconds, 0);

    for (const [eventName, seconds] of entries) {
      const itemEl = this.eventListEl.createDiv({ cls: 'clock-stat-item' });
      if (seconds === maxSeconds) {
        itemEl.addClass('is-dominant');
      }
      const mainEl = itemEl.createDiv({ cls: 'clock-stat-main' });
      const rowEl = mainEl.createDiv({ cls: 'clock-stat-row' });
      rowEl.createDiv({ cls: 'clock-stat-name', text: eventName });
      rowEl.createDiv({
        cls: 'clock-stat-minutes',
        text: this.plugin.formatDuration(seconds)
      });

      const barTrackEl = mainEl.createDiv({ cls: 'clock-stat-bar-track' });
      const barFillEl = barTrackEl.createDiv({ cls: 'clock-stat-bar-fill' });
      barFillEl.style.width = `${Math.max(8, (seconds / maxSeconds) * 100)}%`;

      itemEl.createDiv({
        cls: 'clock-stat-percent',
        text: `${Math.round((seconds / totalSeconds) * 100)}%`
      });
    }
  }

  private renderTimelineChart(segments: SessionSegment[], analysisData: AnalysisData): void {
    this.chartEl.empty();

    if (analysisData.range !== 'day') {
      this.renderRangeTrendChart(segments, analysisData);
      return;
    }

    const chartWidth = this.chartEl.clientWidth || this.contentEl.clientWidth || window.innerWidth;
    const useScrollableChart = chartWidth <= 480;
    const chartContentWidth = useScrollableChart ? 560 : chartWidth;
    const labelStep = useScrollableChart ? 2 : chartWidth <= 360 ? 4 : 2;
    const labelCount = Math.floor(24 / labelStep) + 1;
    const groupedSegments = this.groupSegmentsByQuadrant(segments);

    const legendEl = this.chartEl.createDiv({ cls: 'clock-chart-legend' });
    for (const option of this.plugin.getQuadrantOptions()) {
      const meta = this.plugin.getQuadrantMeta(option.value);
      const itemEl = legendEl.createDiv({ cls: 'clock-chart-legend-item' });
      itemEl.addClass(meta.className);
      itemEl.createDiv({ cls: 'clock-chart-legend-dot' });
      itemEl.createSpan({ text: meta.label });
    }

    if (useScrollableChart) {
      this.chartEl.createDiv({
        cls: 'clock-chart-hint',
        text: '安卓端可左右滑动查看完整 24 小时分布。'
      });
    }

    const scrollEl = this.chartEl.createDiv({ cls: 'clock-chart-scroll' });
    const surfaceEl = scrollEl.createDiv({ cls: 'clock-chart-surface' });
    surfaceEl.style.minWidth = `${chartContentWidth}px`;

    const labelsEl = surfaceEl.createDiv({ cls: 'clock-chart-labels' });
    labelsEl.style.setProperty('--clock-chart-label-count', String(labelCount));

    for (let hour = 0; hour <= 24; hour += labelStep) {
      labelsEl.createDiv({ text: `${String(hour).padStart(2, '0')}:00` });
    }

    if (segments.length === 0) {
      const emptyTrackEl = surfaceEl.createDiv({ cls: 'clock-chart-track' });
      emptyTrackEl.style.setProperty('--clock-chart-grid-columns', String(24 / labelStep));
      emptyTrackEl.createDiv({
        cls: 'clock-empty-state chart-empty',
        text: '暂无时间分布数据。'
      });
      return;
    }

    const now = Date.now();
    const nowPercent = ((now - moment().startOf('day').valueOf()) / 86400000) * 100;

    for (const option of this.plugin.getQuadrantOptions()) {
      const meta = this.plugin.getQuadrantMeta(option.value);
      const laneEl = surfaceEl.createDiv({ cls: 'clock-chart-lane' });
      laneEl.createDiv({
        cls: `clock-chart-lane-label ${meta.className}`,
        text: meta.label
      });

      const trackEl = laneEl.createDiv({ cls: 'clock-chart-track' });
      trackEl.style.setProperty('--clock-chart-grid-columns', String(24 / labelStep));
      trackEl.toggleClass('clock-chart-track-compact', chartWidth <= 420);

      const nowLineEl = trackEl.createDiv({ cls: 'clock-chart-now-line' });
      nowLineEl.style.left = `${Math.min(100, Math.max(0, nowPercent))}%`;

      const quadrantSegments = groupedSegments.get(option.value) ?? [];
      if (quadrantSegments.length === 0) {
        trackEl.createDiv({ cls: 'clock-chart-lane-empty', text: '暂无' });
        continue;
      }

      for (const segment of quadrantSegments) {
        const barEl = trackEl.createDiv({ cls: 'clock-chart-bar' });
        barEl.addClass(meta.className);
        if (segment.sessionId === this.selectedSessionId) {
          barEl.addClass('is-selected');
        }
        const start = moment(segment.dateKey, 'YYYY-MM-DD').startOf('day').valueOf();
        const startPercent = ((segment.startTimestamp - start) / 86400000) * 100;
        const endPercent = ((segment.endTimestamp - start) / 86400000) * 100;
        barEl.style.left = `${startPercent}%`;
        barEl.style.width = `${Math.max(1.5, endPercent - startPercent)}%`;
        barEl.setAttribute(
          'title',
          `[${meta.label}] ${segment.eventName} ${moment(segment.startTimestamp).format('HH:mm:ss')} - ${moment(
            segment.endTimestamp
          ).format('HH:mm:ss')}`
        );
        barEl.setAttribute(
          'aria-label',
          `[${meta.label}] ${segment.eventName} ${moment(segment.startTimestamp).format('HH:mm:ss')} - ${moment(
            segment.endTimestamp
          ).format('HH:mm:ss')}`
        );

        const textEl = barEl.createSpan({ text: segment.eventName });
        textEl.addClass('clock-chart-bar-label');
        if (chartWidth <= 420 || endPercent - startPercent < 14) {
          textEl.setText('');
        }

        barEl.addEventListener('click', () => {
          this.selectedSessionId = this.selectedSessionId === segment.sessionId ? null : segment.sessionId;
          this.renderTimelineChart(this.currentSegments, this.currentAnalysisData ?? analysisData);
          this.renderSessionList(this.currentSessions);
        });
      }
    }
  }

  private renderRangeTrendChart(segments: SessionSegment[], analysisData: AnalysisData): void {
    const filteredBuckets = this.buildFilteredBuckets(analysisData.buckets, segments);
    const maxSeconds = Math.max(...filteredBuckets.map((bucket) => bucket.totalSeconds), 1);

    this.chartEl.createDiv({
      cls: 'clock-chart-hint',
      text: `每根柱子代表一天，当前展示 ${analysisData.label} 在筛选条件下的总投入。`
    });

    if (filteredBuckets.every((bucket) => bucket.totalSeconds === 0)) {
      this.chartEl.createDiv({
        cls: 'clock-empty-state chart-empty',
        text: `${analysisData.shortLabel}没有可展示的趋势数据。`
      });
      return;
    }

    const scrollEl = this.chartEl.createDiv({ cls: 'clock-chart-scroll' });
    const surfaceEl = scrollEl.createDiv({ cls: 'clock-chart-surface' });
    surfaceEl.style.minWidth = `${Math.max(analysisData.range === 'month' ? 720 : 560, filteredBuckets.length * 44)}px`;

    const barsEl = surfaceEl.createDiv({ cls: 'clock-period-bars' });
    barsEl.style.setProperty('--clock-period-bar-count', String(filteredBuckets.length));

    for (const bucket of filteredBuckets) {
      const itemEl = barsEl.createDiv({ cls: 'clock-period-bar-item' });
      if (bucket.totalSeconds === 0) {
        itemEl.addClass('is-empty');
      }
      if (bucket.dateKey === this.selectedDateKey) {
        itemEl.addClass('is-selected');
      }

      itemEl.createDiv({
        cls: 'clock-period-bar-value',
        text: bucket.totalSeconds > 0 ? this.formatCompactDuration(bucket.totalSeconds) : '0'
      });

      const trackEl = itemEl.createDiv({ cls: 'clock-period-bar-track' });
      const fillEl = trackEl.createDiv({ cls: 'clock-period-bar-fill' });
      if (bucket.dominantQuadrant) {
        fillEl.addClass(this.plugin.getQuadrantMeta(bucket.dominantQuadrant).className);
      }
      fillEl.style.height = `${bucket.totalSeconds > 0 ? Math.max(6, (bucket.totalSeconds / maxSeconds) * 100) : 4}%`;
      fillEl.setAttribute(
        'title',
        `${bucket.dateKey} · ${this.plugin.formatDuration(bucket.totalSeconds)} · ${bucket.sessionCount} 条记录`
      );

      itemEl.createDiv({ cls: 'clock-period-bar-label', text: bucket.label });
      itemEl.createDiv({ cls: 'clock-period-bar-meta', text: `${bucket.sessionCount} 条` });

      itemEl.addEventListener('click', () => {
        this.selectedDateKey = this.selectedDateKey === bucket.dateKey ? null : bucket.dateKey;
        this.selectedSessionId = null;
        this.refresh();
      });
    }
  }

  private groupSegmentsByQuadrant(
    segments: SessionSegment[]
  ): Map<EventQuadrant, SessionSegment[]> {
    const grouped = new Map<EventQuadrant, SessionSegment[]>();
    for (const option of this.plugin.getQuadrantOptions()) {
      grouped.set(option.value, []);
    }

    for (const segment of segments) {
      grouped.get(segment.quadrant)?.push(segment);
    }

    return grouped;
  }

  private renderSessionList(sessions: CompletedTimerSession[]): void {
    this.sessionListEl.empty();

    if (sessions.length === 0) {
      this.sessionListEl.createDiv({
        cls: 'clock-empty-state',
        text: `${this.currentAnalysisData?.shortLabel ?? '当前范围'}还没有符合筛选条件的记录。`
      });
      return;
    }

    for (const session of sessions) {
      const itemEl = this.sessionListEl.createDiv({ cls: 'clock-session-item editable' });
      if (session.id === this.selectedSessionId) {
        itemEl.addClass('is-selected');
      }
      const railEl = itemEl.createDiv({ cls: 'clock-session-rail' });
      railEl.createDiv({
        cls: `clock-session-node ${this.plugin.getQuadrantMeta(session.quadrant).className}`
      });
      railEl.createDiv({ cls: 'clock-session-line' });

      const bodyEl = itemEl.createDiv({ cls: 'clock-session-body' });
      const headEl = bodyEl.createDiv({ cls: 'clock-session-head' });
      headEl.createDiv({
        cls: 'clock-session-time-pill',
        text: `${moment(session.startTimestamp).format('HH:mm:ss')} → ${moment(session.endTimestamp).format('HH:mm:ss')}`
      });
      headEl.createDiv({
        cls: 'clock-session-duration-pill',
        text: this.plugin.formatDuration(session.durationSeconds)
      });

      const infoEl = bodyEl.createDiv({ cls: 'clock-session-copy' });
      const metaEl = infoEl.createDiv({ cls: 'clock-session-meta' });
      metaEl.createDiv({
        cls: `clock-session-dot ${this.plugin.getQuadrantMeta(session.quadrant).className}`
      });
      const badgeEl = metaEl.createDiv({
        cls: `clock-quadrant-badge ${this.plugin.getQuadrantMeta(session.quadrant).className}`,
        text: this.plugin.getQuadrantMeta(session.quadrant).label
      });
      badgeEl.setAttribute('title', this.plugin.getQuadrantMeta(session.quadrant).label);
      infoEl.createDiv({
        cls: 'clock-session-time',
        text: `${moment(session.startTimestamp).format('MM-DD HH:mm:ss')} - ${moment(session.endTimestamp).format(
          'MM-DD HH:mm:ss'
        )}`
      });
      infoEl.createDiv({
        cls: 'clock-session-name',
        text: session.eventName
      });

      const actionsEl = bodyEl.createDiv({ cls: 'clock-mini-actions clock-session-actions' });
      const editButton = actionsEl.createEl('button', { text: '编辑' });
      editButton.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      editButton.addEventListener('click', async () => {
        await this.plugin.editSession(session.id);
      });

      const deleteButton = actionsEl.createEl('button', { text: '删除' });
      deleteButton.addClass('mod-warning');
      deleteButton.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      deleteButton.addEventListener('click', async () => {
        await this.plugin.deleteSession(session.id);
      });

      itemEl.addEventListener('click', () => {
        this.selectedSessionId = this.selectedSessionId === session.id ? null : session.id;
        this.renderSessionList(sessions);
        this.renderTimelineChart(
          this.currentSegments,
          this.currentAnalysisData ?? this.plugin.getAnalysisData(this.selectedRange)
        );
      });
    }
  }

  private syncEventFilterOptions(segments: SessionSegment[]): void {
    const eventNames = [...new Set(segments.map((segment) => segment.eventName))].sort((left, right) =>
      left.localeCompare(right, 'zh-CN')
    );

    if (this.selectedEventFilter !== 'all' && !eventNames.includes(this.selectedEventFilter)) {
      this.selectedEventFilter = 'all';
    }

    this.eventFilterEl.empty();
    this.eventFilterEl.createEl('option', { value: 'all', text: '全部事件' });
    for (const eventName of eventNames) {
      this.eventFilterEl.createEl('option', {
        value: eventName,
        text: eventName
      });
    }
    this.eventFilterEl.value = this.selectedEventFilter;
    this.quadrantFilterEl.value = this.selectedQuadrantFilter;
  }

  private applySegmentFilters(
    segments: SessionSegment[],
    quadrantFilter: EventQuadrant | 'all',
    eventFilter: string
  ): SessionSegment[] {
    return segments.filter((segment) => {
      if (quadrantFilter !== 'all' && segment.quadrant !== quadrantFilter) {
        return false;
      }

      if (eventFilter !== 'all' && segment.eventName !== eventFilter) {
        return false;
      }

      return true;
    });
  }

  private buildStatsFromSegments(segments: SessionSegment[]): DailyStats {
    const stats: DailyStats = {
      totalSeconds: 0,
      eventSeconds: {}
    };

    for (const segment of segments) {
      stats.totalSeconds += segment.durationSeconds;
      const label = `${this.plugin.getQuadrantMeta(segment.quadrant).shortLabel} · ${segment.eventName}`;
      stats.eventSeconds[label] = (stats.eventSeconds[label] ?? 0) + segment.durationSeconds;
    }

    return stats;
  }

  private buildFilteredBuckets(
    baseBuckets: AnalysisBucket[],
    segments: SessionSegment[]
  ): AnalysisBucket[] {
    return baseBuckets.map((bucket) => {
      const bucketSegments = segments.filter((segment) => segment.dateKey === bucket.dateKey);
      const quadrantTotals = new Map<EventQuadrant, number>();

      for (const option of this.plugin.getQuadrantOptions()) {
        quadrantTotals.set(option.value, 0);
      }

      for (const segment of bucketSegments) {
        quadrantTotals.set(
          segment.quadrant,
          (quadrantTotals.get(segment.quadrant) ?? 0) + segment.durationSeconds
        );
      }

      return {
        ...bucket,
        totalSeconds: bucketSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0),
        sessionCount: new Set(bucketSegments.map((segment) => segment.sessionId)).size,
        dominantQuadrant:
          [...quadrantTotals.entries()].sort((left, right) => right[1] - left[1])[0]?.[1] > 0
            ? [...quadrantTotals.entries()].sort((left, right) => right[1] - left[1])[0][0]
            : null
      };
    });
  }

  private formatCompactDuration(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.round(totalSeconds));
    if (safeSeconds < 60) {
      return `${safeSeconds}s`;
    }

    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    if (hours === 0) {
      return `${minutes}分`;
    }

    return minutes > 0 ? `${hours}时${minutes}分` : `${hours}时`;
  }

  private getFilterSummaryText(): string {
    const parts: string[] = [];
    if (this.selectedQuadrantFilter !== 'all') {
      parts.push(this.plugin.getQuadrantMeta(this.selectedQuadrantFilter).shortLabel);
    }
    if (this.selectedEventFilter !== 'all') {
      parts.push(this.selectedEventFilter);
    }

    return parts.length > 0 ? `筛选：${parts.join(' / ')}` : '';
  }

  private getQuickEventTargetDateKey(): string {
    return this.selectedDateKey ?? moment().format('YYYY-MM-DD');
  }

  private getCustomRangeBounds(): [string, string] {
    const start =
      this.customRangeStartDateKey || moment().clone().subtract(6, 'days').format('YYYY-MM-DD');
    const end = this.customRangeEndDateKey || moment().format('YYYY-MM-DD');

    return moment(start, 'YYYY-MM-DD').isAfter(moment(end, 'YYYY-MM-DD'))
      ? [end, start]
      : [start, end];
  }

  private getDetailSegments(analysisData: AnalysisData): SessionSegment[] {
    if (!this.selectedDateKey || analysisData.range === 'day') {
      return analysisData.segments;
    }

    return analysisData.segments.filter((segment) => segment.dateKey === this.selectedDateKey);
  }
}

class SessionEditModal extends Modal {
  private session: CompletedTimerSession;
  private onSave: (value: {
    eventName: string;
    startTimestamp: number;
    endTimestamp: number;
    quadrant: EventQuadrant;
  }) => Promise<void>;

  constructor(
    app: App,
    session: CompletedTimerSession,
    onSave: (value: {
      eventName: string;
      startTimestamp: number;
      endTimestamp: number;
      quadrant: EventQuadrant;
    }) => Promise<void>
  ) {
    super(app);
    this.session = session;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('clock-edit-modal');

    contentEl.createEl('h2', { text: '编辑计时记录' });

    contentEl.createEl('label', { text: '事件名称', cls: 'clock-field-label' });
    const eventInput = new TextComponent(contentEl);
    eventInput.setValue(this.session.eventName);

    contentEl.createEl('label', { text: '事件分类', cls: 'clock-field-label' });
    const quadrantSelect = contentEl.createEl('select', { cls: 'clock-category-select' });
    for (const [value, meta] of Object.entries(QUADRANT_META) as Array<[EventQuadrant, QuadrantMeta]>) {
      quadrantSelect.createEl('option', {
        value,
        text: meta.label
      });
    }
    quadrantSelect.value = this.session.quadrant;

    contentEl.createEl('label', { text: '开始时间', cls: 'clock-field-label' });
    const startInput = contentEl.createEl('input', { type: 'datetime-local' });
    startInput.step = '1';
    startInput.value = moment(this.session.startTimestamp).format('YYYY-MM-DDTHH:mm:ss');

    contentEl.createEl('label', { text: '结束时间', cls: 'clock-field-label' });
    const endInput = contentEl.createEl('input', { type: 'datetime-local' });
    endInput.step = '1';
    endInput.value = moment(this.session.endTimestamp).format('YYYY-MM-DDTHH:mm:ss');

    const actionsEl = contentEl.createDiv({ cls: 'clock-actions modal-actions' });
    const saveButton = actionsEl.createEl('button', { text: '保存', cls: 'mod-cta' });
    const cancelButton = actionsEl.createEl('button', { text: '取消' });

    saveButton.addEventListener('click', async () => {
      const eventName = eventInput.getValue().trim();
      const startTimestamp = moment(startInput.value).valueOf();
      const endTimestamp = moment(endInput.value).valueOf();

      if (!eventName) {
        new Notice('事件名称不能为空。');
        return;
      }

      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        new Notice('请输入有效的开始/结束时间。');
        return;
      }

      if (endTimestamp <= startTimestamp) {
        new Notice('结束时间必须晚于开始时间。');
        return;
      }

      await this.onSave({
        eventName,
        startTimestamp,
        endTimestamp,
        quadrant: quadrantSelect.value as EventQuadrant
      });
      this.close();
    });

    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class AssignInboxItemModal extends Modal {
  private itemTitle: string;
  private initialDateKey: string;
  private onAssign: (dateKey: string, startNow: boolean) => Promise<void>;

  constructor(
    app: App,
    itemTitle: string,
    initialDateKey: string,
    onAssign: (dateKey: string, startNow: boolean) => Promise<void>
  ) {
    super(app);
    this.itemTitle = itemTitle;
    this.initialDateKey = initialDateKey;
    this.onAssign = onAssign;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('clock-edit-modal');

    contentEl.createEl('h2', { text: '分配收集箱事务' });
    contentEl.createDiv({
      cls: 'clock-section-description',
      text: `把「${this.itemTitle}」分配到指定日期的日志事件区块中。`
    });

    contentEl.createEl('label', { text: '目标日期', cls: 'clock-field-label' });
    const dateInput = contentEl.createEl('input', { type: 'date' });
    dateInput.value = this.initialDateKey;
    dateInput.addClass('clock-event-input');

    const startNowWrap = contentEl.createDiv({ cls: 'clock-checkbox-row' });
    const startNowInput = startNowWrap.createEl('input', { type: 'checkbox' });
    startNowInput.id = 'clock-assign-start-now';
    const startNowLabel = startNowWrap.createEl('label', {
      text: '分配后立即开始计时（仅今天可用）'
    });
    startNowLabel.setAttribute('for', startNowInput.id);

    const syncStartNowState = (): void => {
      const isToday = dateInput.value === moment().format('YYYY-MM-DD');
      startNowInput.disabled = !isToday;
      if (!isToday) {
        startNowInput.checked = false;
      }
    };

    syncStartNowState();
    dateInput.addEventListener('change', syncStartNowState);

    const actionsEl = contentEl.createDiv({ cls: 'clock-actions modal-actions' });
    const confirmButton = actionsEl.createEl('button', { text: '确认分配', cls: 'mod-cta' });
    const cancelButton = actionsEl.createEl('button', { text: '取消' });

    confirmButton.addEventListener('click', async () => {
      const dateKey = dateInput.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
        new Notice('请选择有效日期。');
        return;
      }

      await this.onAssign(dateKey, startNowInput.checked);
      this.close();
    });

    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ManualSessionModal extends Modal {
  private initialValue: {
    eventName: string;
    quadrant: EventQuadrant;
    dateKey: string;
  };
  private onSubmit: (value: {
    eventName: string;
    startTimestamp: number;
    endTimestamp: number;
    quadrant: EventQuadrant;
  }) => Promise<void>;

  constructor(
    app: App,
    initialValue: {
      eventName: string;
      quadrant: EventQuadrant;
      dateKey: string;
    },
    onSubmit: (value: {
      eventName: string;
      startTimestamp: number;
      endTimestamp: number;
      quadrant: EventQuadrant;
    }) => Promise<void>
  ) {
    super(app);
    this.initialValue = initialValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('clock-edit-modal');

    contentEl.createEl('h2', { text: '直接补录事件' });
    contentEl.createDiv({
      cls: 'clock-section-description',
      text: '填写事件名、开始时间和结束时间，保存后会直接写入日志记录与统计。'
    });

    const baseMoment = moment(this.initialValue.dateKey, 'YYYY-MM-DD');
    const defaultStart = baseMoment.clone().hour(9).minute(0).second(0);
    const defaultEnd = baseMoment.clone().hour(9).minute(30).second(0);
    if (this.initialValue.dateKey === moment().format('YYYY-MM-DD')) {
      defaultEnd.year(moment().year()).month(moment().month()).date(moment().date());
      defaultEnd.hour(moment().hour()).minute(moment().minute()).second(moment().second());
      defaultStart
        .year(moment().year())
        .month(moment().month())
        .date(moment().date())
        .hour(moment().clone().subtract(30, 'minutes').hour())
        .minute(moment().clone().subtract(30, 'minutes').minute())
        .second(moment().clone().subtract(30, 'minutes').second());
    }

    contentEl.createEl('label', { text: '事件名称', cls: 'clock-field-label' });
    const eventInput = new TextComponent(contentEl);
    eventInput.setValue(this.initialValue.eventName);

    contentEl.createEl('label', { text: '事件分类', cls: 'clock-field-label' });
    const quadrantSelect = contentEl.createEl('select', { cls: 'clock-category-select' });
    for (const [value, meta] of Object.entries(QUADRANT_META) as Array<[EventQuadrant, QuadrantMeta]>) {
      quadrantSelect.createEl('option', {
        value,
        text: meta.label
      });
    }
    quadrantSelect.value = this.initialValue.quadrant;

    contentEl.createEl('label', { text: '开始时间', cls: 'clock-field-label' });
    const startInput = contentEl.createEl('input', { type: 'datetime-local' });
    startInput.step = '1';
    startInput.value = defaultStart.format('YYYY-MM-DDTHH:mm:ss');

    contentEl.createEl('label', { text: '结束时间', cls: 'clock-field-label' });
    const endInput = contentEl.createEl('input', { type: 'datetime-local' });
    endInput.step = '1';
    endInput.value = defaultEnd.format('YYYY-MM-DDTHH:mm:ss');

    const actionsEl = contentEl.createDiv({ cls: 'clock-actions modal-actions' });
    const saveButton = actionsEl.createEl('button', { text: '写入记录', cls: 'mod-cta' });
    const cancelButton = actionsEl.createEl('button', { text: '取消' });

    saveButton.addEventListener('click', async () => {
      const eventName = eventInput.getValue().trim();
      const startTimestamp = moment(startInput.value).valueOf();
      const endTimestamp = moment(endInput.value).valueOf();

      if (!eventName) {
        new Notice('事件名称不能为空。');
        return;
      }

      if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
        new Notice('请输入有效的开始/结束时间。');
        return;
      }

      if (endTimestamp <= startTimestamp) {
        new Notice('结束时间必须晚于开始时间。');
        return;
      }

      await this.onSubmit({
        eventName,
        startTimestamp,
        endTimestamp,
        quadrant: quadrantSelect.value as EventQuadrant
      });
      this.close();
    });

    cancelButton.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ClockTimerSettingTab extends PluginSettingTab {
  private plugin: ClockTimerPlugin;

  constructor(app: App, plugin: ClockTimerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '时钟计时插件设置' });

    new Setting(containerEl)
      .setName('优先兼容官方 Daily Notes')
      .setDesc('启用后，优先读取 Obsidian 官方 Daily Notes 的文件夹和日期格式配置。')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.preferOfficialDailyNotes).onChange(async (value) => {
          this.plugin.settings.preferOfficialDailyNotes = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('今日日志创建方式')
      .setDesc('可选择按模板直接创建，或优先交给 Daily Notes 插件创建后再插入本插件的托管区块。')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('template', '按模板 / 默认格式创建')
          .addOption('official-plugin', '先走 Daily Notes 插件创建')
          .setValue(this.plugin.settings.dailyNoteCreateMode)
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteCreateMode = value as DailyNoteCreateMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('日记文件夹')
      .setDesc('当未启用官方 Daily Notes 兼容，或未读取到官方配置时使用。')
      .addText((text) => {
        text
          .setPlaceholder('Daily')
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange(async (value: string) => {
            this.plugin.settings.dailyNoteFolder = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('日记文件名格式')
      .setDesc('使用 moment.js 格式，例如 YYYY-MM-DD。')
      .addText((text) => {
        text
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.dailyNoteFormat)
          .onChange(async (value: string) => {
            this.plugin.settings.dailyNoteFormat = value.trim() || DEFAULT_SETTINGS.dailyNoteFormat;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('日志模板文件')
      .setDesc('创建今日日志时使用的模板文件路径；启用官方 Daily Notes 兼容时优先使用官方模板路径。')
      .addText((text) => {
        text
          .setPlaceholder('Templates/Daily.md')
          .setValue(this.plugin.settings.dailyNoteTemplatePath)
          .onChange(async (value: string) => {
            this.plugin.settings.dailyNoteTemplatePath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('收集箱文件')
      .setDesc('用于收集杂乱事务、临时想法、待处理事项的独立文件路径。')
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.inboxFilePath)
          .setValue(this.plugin.settings.inboxFilePath)
          .onChange(async (value: string) => {
            this.plugin.settings.inboxFilePath = value.trim() || DEFAULT_SETTINGS.inboxFilePath;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('统计汇总标题')
      .setDesc('自动写入到当日日记末尾的汇总区块标题。')
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.statsHeading)
          .setValue(this.plugin.settings.statsHeading)
          .onChange(async (value: string) => {
            this.plugin.settings.statsHeading = value.trim() || DEFAULT_SETTINGS.statsHeading;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('隐藏界面装饰标签')
      .setDesc('隐藏侧栏里的装饰性标签，例如卡片眉标、阶段徽标和象限徽标，让界面更干净。')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hideDecorativeLabels).onChange(async (value) => {
          this.plugin.settings.hideDecorativeLabels = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('番茄工作时长（分钟）')
      .setDesc('每轮专注时长。')
      .addText((text) => {
        text
          .setPlaceholder('25')
          .setValue(String(this.plugin.settings.pomodoroWorkMinutes))
          .onChange(async (value: string) => {
            this.plugin.settings.pomodoroWorkMinutes = Number(value) || DEFAULT_SETTINGS.pomodoroWorkMinutes;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('番茄休息时长（分钟）')
      .setDesc('工作结束后休息时长。')
      .addText((text) => {
        text
          .setPlaceholder('5')
          .setValue(String(this.plugin.settings.pomodoroBreakMinutes))
          .onChange(async (value: string) => {
            this.plugin.settings.pomodoroBreakMinutes = Number(value) || DEFAULT_SETTINGS.pomodoroBreakMinutes;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('工作结束后自动开始休息')
      .setDesc('关闭后，番茄钟工作结束仅提醒，不自动进入休息阶段。')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.pomodoroAutoStartBreak).onChange(async (value) => {
          this.plugin.settings.pomodoroAutoStartBreak = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('启动时自动打开侧栏')
      .setDesc('启用后，Obsidian 启动并加载插件时自动显示计时侧栏。')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoOpenSidebar).onChange(async (value) => {
          this.plugin.settings.autoOpenSidebar = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
