/**
 * @maaxyz/maa-node 的类型只在**全局命名空间** maa 里声明（declare global），
 * 运行时则是 module.exports = globalThis.maa —— 两者对不上：
 *   - 默认 import 拿到的是"空模块"类型，取 .Resource 会报 TS2339
 *   - 而局部名 maa 又会遮蔽全局类型命名空间
 * 所以这里做一层最小门面：值走 globalThis，类型继续用全局 maa.*。
 */
import '@maaxyz/maa-node'

interface MaaModule {
  Resource: new () => maa.Resource
  CustomController: new (actor: maa.CustomControllerActor) => maa.Controller
  Tasker: new () => maa.Tasker
}

export const maafw = (globalThis as unknown as { maa: MaaModule }).maa
