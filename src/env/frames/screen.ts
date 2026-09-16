/** 一屏画面。transitions 声明"点在哪里会走到哪一屏"，缺省表示输入不改变画面。 */
export interface FramesScreen {
  /** 屏名，也是 env_state 断言的取值 */
  name: string
  /** PNG 文件路径 */
  path: string
  /** 命中区：落在矩形内的输入才把画面切到 target */
  transitions?: ScreenTransition[]
}

export interface ScreenTransition {
  /** 屏幕坐标矩形 [x, y, w, h] */
  area: [number, number, number, number]
  target: string
}
