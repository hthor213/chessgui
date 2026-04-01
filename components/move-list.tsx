"use client"

import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"

interface MoveListProps {
  moves: string[];
  currentIndex: number;
  onGoToMove: (index: number) => void;
}

export function MoveList({ moves, currentIndex, onGoToMove }: MoveListProps) {
  const pairs: [string, string | undefined][] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push([moves[i], moves[i + 1]]);
  }

  return (
    <Card className="bg-[#1e1c19] border-[#2a2825] p-3 flex-1 overflow-hidden">
      <span className="text-xs font-semibold text-[#bababa] mb-2 block">
        Moves
      </span>
      <ScrollArea className="h-[calc(100%-28px)]">
        {pairs.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Play a move to begin...
          </span>
        ) : (
          pairs.map(([white, black], pairIdx) => (
            <div key={pairIdx} className="flex flex-nowrap mb-px">
              <span
                className="text-xs text-muted-foreground w-7 text-right mr-1.5 font-mono shrink-0"
              >
                {pairIdx + 1}.
              </span>
              <span
                className={`text-sm font-mono w-[70px] px-1.5 py-px rounded-sm cursor-pointer shrink-0 ${
                  currentIndex === pairIdx * 2
                    ? "font-bold text-white bg-[rgba(155,199,0,0.25)]"
                    : "font-normal text-[#bababa]"
                }`}
                onClick={() => onGoToMove(pairIdx * 2)}
              >
                {white}
              </span>
              {black && (
                <span
                  className={`text-sm font-mono w-[70px] px-1.5 py-px rounded-sm cursor-pointer shrink-0 ${
                    currentIndex === pairIdx * 2 + 1
                      ? "font-bold text-white bg-[rgba(155,199,0,0.25)]"
                      : "font-normal text-[#bababa]"
                  }`}
                  onClick={() => onGoToMove(pairIdx * 2 + 1)}
                >
                  {black}
                </span>
              )}
            </div>
          ))
        )}
      </ScrollArea>
    </Card>
  );
}
