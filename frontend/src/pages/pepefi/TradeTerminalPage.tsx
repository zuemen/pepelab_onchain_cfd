import { TerminalView } from 'src/sections/terminal'

// 路由層的薄殼。版面與狀態都在 src/sections/terminal/ —— 這一頁的內容多到
// 塞在單一檔案裡沒辦法 review，拆檔後每個面板可以各自替換。
export default function TradeTerminalPage() {
  return <TerminalView />
}
