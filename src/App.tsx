import { useCallback, useEffect, useMemo, useState } from 'react';
import { LEVELS } from './data/levels';
import {
  ExecutionStatus,
  ExecutionStep,
  PathSegment,
  PlaybackSpeed,
  Point,
  RobotPose,
} from './types/game';
import { parseLogoProgram, pointsEqual } from './utils/logoParser';
import { TopBar } from './components/TopBar';
import { CommandPanel } from './components/CommandPanel';
import { GameBoard } from './components/GameBoard';
import { GuideModal } from './components/GuideModal';

const STORAGE_KEY = 'basqariw_robot_completed_v1';
const SANDBOX_START: RobotPose = { x: 5, y: 5, angle: 0 };

function loadCompletedLevels(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === 'number')
      : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [mode, setMode] = useState<'levels' | 'sandbox'>('levels');
  const [currentLevelId, setCurrentLevelId] = useState<number>(1);
  const [completedLevelIds, setCompletedLevelIds] = useState<number[]>(() =>
    loadCompletedLevels()
  );

  // Store code per level + sandbox so switching tabs keeps user's draft
  const [codeByTarget, setCodeByTarget] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {
      sandbox: 'REPEAT 4 [\n  FD 3\n  RT 90\n]',
    };
    for (const lvl of LEVELS) {
      initial[`level-${lvl.id}`] = lvl.starterCode;
    }
    return initial;
  });

  const currentLevel = useMemo(
    () => LEVELS.find((l) => l.id === currentLevelId) ?? LEVELS[0],
    [currentLevelId]
  );

  const codeKey = mode === 'sandbox' ? 'sandbox' : `level-${currentLevel.id}`;
  const currentCode = codeByTarget[codeKey] ?? '';

  const startPose: RobotPose =
    mode === 'sandbox' ? SANDBOX_START : currentLevel.start;

  const [robotPose, setRobotPose] = useState<RobotPose>(startPose);
  const [pathSegments, setPathSegments] = useState<PathSegment[]>([]);
  const [collectedCheckpoints, setCollectedCheckpoints] = useState<Point[]>([]);
  const [penDown, setPenDown] = useState<boolean>(true);

  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [commandCount, setCommandCount] = useState<number>(0);
  const [status, setStatus] = useState<ExecutionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [speed, setSpeed] = useState<PlaybackSpeed>('normal');
  const [isGuideOpen, setIsGuideOpen] = useState<boolean>(false);

  // Live command count preview while typing
  const liveParsePreview = useMemo(() => parseLogoProgram(currentCode), [currentCode]);

  const resetBoardToStart = useCallback(
    (targetPose: RobotPose) => {
      setRobotPose(targetPose);
      setPathSegments([]);
      setCollectedCheckpoints([]);
      setPenDown(true);
      setSteps([]);
      setStepIndex(0);
      setStatus('idle');
      setErrorMessage(null);
      setErrorLine(null);
      setActiveLine(null);
    },
    []
  );

  const handleSelectLevel = useCallback(
    (levelId: number) => {
      const targetLvl = LEVELS.find((l) => l.id === levelId) ?? LEVELS[0];
      setMode('levels');
      setCurrentLevelId(levelId);
      resetBoardToStart(targetLvl.start);
    },
    [resetBoardToStart]
  );

  const handleModeChange = useCallback(
    (nextMode: 'levels' | 'sandbox') => {
      setMode(nextMode);
      resetBoardToStart(
        nextMode === 'sandbox' ? SANDBOX_START : currentLevel.start
      );
    },
    [currentLevel.start, resetBoardToStart]
  );

  const handleCodeChange = useCallback(
    (newCode: string) => {
      setCodeByTarget((prev) => ({ ...prev, [codeKey]: newCode }));
      if (status === 'error' || status === 'won' || status === 'stopped') {
        setErrorMessage(null);
        setErrorLine(null);
        if (status === 'error') setStatus('idle');
      }
    },
    [codeKey, status]
  );

  const executeSingleStep = useCallback(
    (
      step: ExecutionStep,
      pose: RobotPose,
      collected: Point[],
      isPenDown: boolean
    ): {
      nextPose: RobotPose;
      newSegment: PathSegment | null;
      nextCollected: Point[];
      nextPenDown: boolean;
      clearPath: boolean;
      error: string | null;
    } => {
      if (step.type === 'turn') {
        return {
          nextPose: { ...pose, angle: pose.angle + step.amount },
          newSegment: null,
          nextCollected: collected,
          nextPenDown: isPenDown,
          clearPath: false,
          error: null,
        };
      }

      if (step.type === 'pen') {
        return {
          nextPose: pose,
          newSegment: null,
          nextCollected: collected,
          nextPenDown: step.penDown ?? true,
          clearPath: false,
          error: null,
        };
      }

      if (step.type === 'clear') {
        return {
          nextPose: mode === 'sandbox' ? SANDBOX_START : currentLevel.start,
          newSegment: null,
          nextCollected: [],
          nextPenDown: true,
          clearPath: true,
          error: null,
        };
      }

      // Move step: walk in small sub-steps (<= 1 unit) for accurate wall/boundary checks
      const totalDist = step.amount;
      const sign = totalDist >= 0 ? 1 : -1;
      const absDist = Math.abs(totalDist);
      const rad = (pose.angle * Math.PI) / 180;
      const dirX = Math.sin(rad) * sign;
      const dirY = Math.cos(rad) * sign;

      const subStepCount = Math.max(1, Math.ceil(absDist));
      const subStepSize = absDist / subStepCount;

      let curX = pose.x;
      let curY = pose.y;
      const updatedCollected = [...collected];

      for (let s = 1; s <= subStepCount; s++) {
        const nextX = Math.round((curX + dirX * subStepSize) * 1000) / 1000;
        const nextY = Math.round((curY + dirY * subStepSize) * 1000) / 1000;

        // Boundary check [0..10]
        if (nextX < -0.01 || nextX > 10.01 || nextY < -0.01 || nextY > 10.01) {
          const validSegment =
            curX !== pose.x || curY !== pose.y
              ? {
                  from: { x: pose.x, y: pose.y },
                  to: { x: curX, y: curY },
                  isBackward: sign < 0,
                  penDown: isPenDown,
                }
              : null;
          return {
            nextPose: { ...pose, x: curX, y: curY },
            newSegment: validSegment,
            nextCollected: updatedCollected,
            nextPenDown: isPenDown,
            clearPath: false,
            error: `${step.lineNumber}-qatar: Robot maydan shegarasınan (0..10) shıǵıp ketti!`,
          };
        }

        // Obstacle collision check in levels mode
        if (mode === 'levels') {
          const hitObs = currentLevel.obstacles.find((obs) =>
            pointsEqual(obs, { x: nextX, y: nextY }, 0.2)
          );
          if (hitObs) {
            const validSegment =
              curX !== pose.x || curY !== pose.y
                ? {
                    from: { x: pose.x, y: pose.y },
                    to: { x: curX, y: curY },
                    isBackward: sign < 0,
                    penDown: isPenDown,
                  }
                : null;
            return {
              nextPose: { ...pose, x: curX, y: curY },
              newSegment: validSegment,
              nextCollected: updatedCollected,
              nextPenDown: isPenDown,
              clearPath: false,
              error: `${step.lineNumber}-qatar: Robot (${hitObs.x}, ${hitObs.y}) noqattaǵı tosıqqa urıldı!`,
            };
          }

          // Collect checkpoints passed along the path
          for (const cp of currentLevel.checkpoints) {
            const matches = pointsEqual(cp, { x: nextX, y: nextY }, 0.2);
            const already = updatedCollected.some((c) => pointsEqual(c, cp));
            if (matches && !already) {
              updatedCollected.push(cp);
            }
          }
        }

        curX = nextX;
        curY = nextY;
      }

      return {
        nextPose: { ...pose, x: curX, y: curY },
        newSegment:
          absDist > 0
            ? {
                from: { x: pose.x, y: pose.y },
                to: { x: curX, y: curY },
                isBackward: sign < 0,
                penDown: isPenDown,
              }
            : null,
        nextCollected: updatedCollected,
        nextPenDown: isPenDown,
        clearPath: false,
        error: null,
      };
    },
    [currentLevel.checkpoints, currentLevel.obstacles, currentLevel.start, mode]
  );

  const evaluateCompletion = useCallback(
    (finalPose: RobotPose, finalCollected: Point[]) => {
      if (mode === 'sandbox') {
        setStatus('stopped');
        setActiveLine(null);
        return;
      }

      const atTarget = pointsEqual(finalPose, currentLevel.target, 0.12);
      const allCheckpoints = currentLevel.checkpoints.every((cp) =>
        finalCollected.some((c) => pointsEqual(c, cp))
      );

      if (atTarget && allCheckpoints) {
        setStatus('won');
        setActiveLine(null);
        setCompletedLevelIds((prev) => {
          if (prev.includes(currentLevel.id)) return prev;
          const next = [...prev, currentLevel.id];
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore storage failure
          }
          return next;
        });
      } else if (atTarget && !allCheckpoints) {
        setStatus('error');
        setActiveLine(null);
        setErrorMessage(
          `Robot bayraqshaǵa jetti, biraq barlıq juldızshalar jıynalmadı (${finalCollected.length}/${currentLevel.checkpoints.length}).`
        );
      } else {
        setStatus('error');
        setActiveLine(null);
        setErrorMessage(
          `Programma tamamlandı, biraq robot (${currentLevel.target.x}, ${currentLevel.target.y}) bayraqshaǵa jetpedi.`
        );
      }
    },
    [currentLevel.checkpoints, currentLevel.id, currentLevel.target, mode]
  );

  // Playback Timer Effect
  useEffect(() => {
    if (status !== 'running') return;

    const delay = speed === 'slow' ? 620 : speed === 'normal' ? 340 : 140;

    if (stepIndex >= steps.length) {
      const finishTimer = window.setTimeout(() => {
        evaluateCompletion(robotPose, collectedCheckpoints);
      }, delay * 0.75);
      return () => window.clearTimeout(finishTimer);
    }

    const timer = window.setTimeout(() => {
      const currentStep = steps[stepIndex];
      setActiveLine(currentStep.lineNumber);

      const outcome = executeSingleStep(
        currentStep,
        robotPose,
        collectedCheckpoints,
        penDown
      );

      setRobotPose(outcome.nextPose);
      if (outcome.clearPath) {
        setPathSegments([]);
      } else if (outcome.newSegment) {
        setPathSegments((prev) => [...prev, outcome.newSegment!]);
      }
      setCollectedCheckpoints(outcome.nextCollected);
      setPenDown(outcome.nextPenDown);

      if (outcome.error) {
        setStatus('error');
        setErrorMessage(outcome.error);
        setErrorLine(currentStep.lineNumber);
        return;
      }

      setStepIndex(stepIndex + 1);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [
    collectedCheckpoints,
    evaluateCompletion,
    executeSingleStep,
    penDown,
    robotPose,
    speed,
    status,
    stepIndex,
    steps,
  ]);

  const handleRun = () => {
    if (status === 'paused' && stepIndex < steps.length) {
      setStatus('running');
      return;
    }

    const parsed = parseLogoProgram(currentCode);
    if (parsed.error) {
      resetBoardToStart(startPose);
      setStatus('error');
      setErrorMessage(parsed.error);
      setErrorLine(parsed.errorLine);
      return;
    }

    resetBoardToStart(startPose);
    setSteps(parsed.steps);
    setCommandCount(parsed.commandCount);
    setStepIndex(0);
    setStatus('running');
  };

  const handlePause = () => {
    if (status === 'running') {
      setStatus('paused');
    }
  };

  const handleStep = () => {
    if (status === 'running') return;

    let activeSteps = steps;
    let curIdx = stepIndex;
    let curPose = robotPose;
    let curCollected = collectedCheckpoints;
    let curPen = penDown;

    if (status !== 'paused' || steps.length === 0) {
      const parsed = parseLogoProgram(currentCode);
      if (parsed.error) {
        resetBoardToStart(startPose);
        setStatus('error');
        setErrorMessage(parsed.error);
        setErrorLine(parsed.errorLine);
        return;
      }
      curPose = startPose;
      curCollected = [];
      curPen = true;
      curIdx = 0;
      activeSteps = parsed.steps;

      setRobotPose(startPose);
      setPathSegments([]);
      setCollectedCheckpoints([]);
      setPenDown(true);
      setSteps(parsed.steps);
      setCommandCount(parsed.commandCount);
      setErrorMessage(null);
      setErrorLine(null);
    }

    if (curIdx >= activeSteps.length) {
      evaluateCompletion(curPose, curCollected);
      return;
    }

    const currentStep = activeSteps[curIdx];
    setActiveLine(currentStep.lineNumber);

    const outcome = executeSingleStep(
      currentStep,
      curPose,
      curCollected,
      curPen
    );

    setRobotPose(outcome.nextPose);
    if (outcome.clearPath) {
      setPathSegments([]);
    } else if (outcome.newSegment) {
      setPathSegments((prev) => [...prev, outcome.newSegment!]);
    }
    setCollectedCheckpoints(outcome.nextCollected);
    setPenDown(outcome.nextPenDown);

    if (outcome.error) {
      setStatus('error');
      setErrorMessage(outcome.error);
      setErrorLine(currentStep.lineNumber);
      return;
    }

    const nextIdx = curIdx + 1;
    setStepIndex(nextIdx);
    if (nextIdx >= activeSteps.length) {
      evaluateCompletion(outcome.nextPose, outcome.nextCollected);
    } else {
      setStatus('paused');
    }
  };

  const handleResetBoard = () => {
    resetBoardToStart(startPose);
  };

  const handleClearCode = () => {
    setCodeByTarget((prev) => ({ ...prev, [codeKey]: '' }));
    resetBoardToStart(startPose);
  };

  const handleLoadSandboxPreset = (presetCode: string) => {
    setCodeByTarget((prev) => ({ ...prev, sandbox: presetCode }));
    resetBoardToStart(SANDBOX_START);
  };

  const handleNextLevel = () => {
    const idx = LEVELS.findIndex((l) => l.id === currentLevel.id);
    if (idx >= 0 && idx < LEVELS.length - 1) {
      handleSelectLevel(LEVELS[idx + 1].id);
    }
  };

  const handleResetAll = () => {
    if (mode === 'levels') {
      setCodeByTarget((prev) => ({
        ...prev,
        [`level-${currentLevel.id}`]: currentLevel.starterCode,
      }));
      resetBoardToStart(currentLevel.start);
    } else {
      resetBoardToStart(SANDBOX_START);
    }
  };

  const hasNextLevel =
    mode === 'levels' &&
    LEVELS.findIndex((l) => l.id === currentLevel.id) < LEVELS.length - 1;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        mode={mode}
        onModeChange={handleModeChange}
        onOpenGuide={() => setIsGuideOpen(true)}
        onResetAll={handleResetAll}
      />

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6">
        {/* Two-Column Split: Left = Buyrıq paneli, Right = Oyın maydanı */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          <div className="lg:col-span-5 flex flex-col">
            <CommandPanel
              code={currentCode}
              onCodeChange={handleCodeChange}
              status={status}
              errorMessage={errorMessage}
              errorLine={errorLine}
              activeLine={activeLine}
              hint={mode === 'levels' ? currentLevel.hint : null}
              speed={speed}
              onSpeedChange={setSpeed}
              onRun={handleRun}
              onPause={handlePause}
              onStep={handleStep}
              onResetBoard={handleResetBoard}
              onClearCode={handleClearCode}
              onNextLevel={handleNextLevel}
              hasNextLevel={hasNextLevel}
              isSandbox={mode === 'sandbox'}
              stepsExecuted={stepIndex}
              optimalSteps={
                mode === 'levels' ? currentLevel.optimalSteps : undefined
              }
              commandCount={
                status === 'idle' ? liveParsePreview.commandCount : commandCount
              }
            />
          </div>

          <div className="lg:col-span-7 flex flex-col">
            <GameBoard
              mode={mode}
              levels={LEVELS}
              currentLevel={currentLevel}
              completedLevelIds={completedLevelIds}
              onSelectLevel={handleSelectLevel}
              onLoadSandboxPreset={handleLoadSandboxPreset}
              robotPose={robotPose}
              pathSegments={pathSegments}
              collectedCheckpoints={collectedCheckpoints}
              status={status}
              speed={speed}
              commandCount={
                status === 'idle' ? liveParsePreview.commandCount : commandCount
              }
              penDown={penDown}
            />
          </div>
        </div>
      </main>

      <GuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
      />
    </div>
  );
}
