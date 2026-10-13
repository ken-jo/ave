import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "미팅 종료 → 자동 작업" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Event-driven flow"
        title="미팅 종료 → 액션 아이템 추출 (Routine 아님)"
        description="이 흐름은 RoutineEngine 가 아니라 이벤트를 구독하는 익스텐션이 담당합니다 — meeting extension이 meeting.summary.created 를 emit 하면 구독 익스텐션이 surface 여부를 정한 뒤 사용자 카드로 노출합니다."
        tags={["event-driven", "meeting.summary.created"]}
      />

      <h2 id="flow">한 사이클</h2>
      <StepList
        steps={[
          { title: "회의 종료 감지", body: <p>meeting extension이 사용자 stop / floating window 종료에서 <code>meeting.ended</code> emit → 모든 transcript 가 SessionStore 에 저장.</p>, badge: "meeting" },
          { title: "요약 생성", body: <p>meeting extension이 호스트 LLM (<code>callLlm</code>) 으로 transcript 요약 + <code>actionItems</code> 추출. 결과를 <code>meeting.summary.created</code> 로 emit.</p> },
          { title: "구독 익스텐션 진입", body: <p>이 이벤트를 구독하는 익스텐션이 자체 정책을 평가한 뒤 surface 여부를 결정합니다.</p> },
          { title: "Proactive card", body: <p>surface 결정 시 <code>hostApi.triggerConversation</code> 으로 채팅 본문에 카드 노출. 사용자 선택지 표시 (Tasks/메일/요약 저장).</p> },
          { title: "후속 액션", body: <p>사용자가 선택하면 그 익스텐션이 메일·캘린더 익스텐션 도구로 실제 작업 수행 (예: 캘린더 등록, 업무 보드 카드 생성).</p>, badge: "최종" },
        ]}
      />

      <Callout tone="tip" title="이 흐름을 끄려면">
        <ul className="my-1 list-disc pl-5">
          <li><strong>익스텐션 쪽</strong>: meeting <code>autoSummarize=false</code> 로 요약 자체 차단.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
