#!/usr/bin/env python3
"""重新生成动画的中文旁白，并写回 public/animation/player.html 中内嵌的 VO_DATA。

用法（需要 uv；无需其它依赖）：
    python3 scripts/animation/gen_vo.py          # 生成并写回播放器
    python3 scripts/animation/gen_vo.py --dry    # 只合成并打印每句时长，不写文件

- 语音：Microsoft Edge 神经语音（edge-tts），默认 zh-CN-XiaoxiaoNeural（女声，温暖自然）
- 每句写在对应场景的时间点上（相对场景开头的秒数）；若读得比留给它的时间长，
  会自动小幅加快语速（最多 +14%），仍放不下时在输出里标记 OVER，需要缩短文案
- 字幕文字与旁白一致；spoken 用于替换缩写的读法（如 IOPS → I O P S）
- 时长用 macOS 自带的 afinfo 测量
"""
import base64, json, pathlib, re, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLAYER = ROOT / 'public/animation/player.html'
VOICE = 'zh-CN-XiaoxiaoNeural'
BASE_RATE = 8
MAX_RATE = 14
# 各场景时长（秒），需与 player.html 中 SCENES 的 dur 保持一致
DUR = [10.5, 30, 37, 31, 32.5, 40.5, 31.5, 18]

# (场景序号, 场景内开始时间, 字幕/文案, 读法覆盖)
L = [
    (0, 3.2, "从第一块磁盘，到生产级存储集群——一段从零到专业的存储之旅。", None),
    (1, 3.2, "数据住在哪里？从纳秒级的内存，到毫秒级的机械盘，延迟相差十万倍。", None),
    (1, 10.9, "先搭一个能随便折腾的实验环境：几条命令，就造出一排虚拟磁盘。", None),
    (1, 17.6, "再跟着一次 write()，穿过页缓存、文件系统和块层，一路落到磁盘上。",
     "再跟着一次 write 调用，穿过页缓存、文件系统和块层，一路落到磁盘上。"),
    (1, 24.9, "这条 I/O 路径，就是贯穿整门课的地图。", "这条 I O 路径，就是贯穿整门课的地图。"),
    (2, 3.2, "机械盘靠磁头寻道，固态盘靠闪存并行，NVMe 让它全速奔跑。",
     "机械盘靠磁头寻道，固态盘靠闪存并行，N V M E 让它全速奔跑。"),
    (2, 10.5, "分区与 LVM，把几块物理盘拼成一个能在线扩容的逻辑卷。",
     "分区与 L V M，把几块物理盘拼成一个能在线扩容的逻辑卷。"),
    (2, 16.8, "RAID 用条带和校验换来冗余：坏掉一块盘，数据依然完好。",
     "Raid 用条带和校验换来冗余：坏掉一块盘，数据依然完好。"),
    (2, 23.0, "写成功不等于落盘：数据先进页缓存，调用 fsync 才算真正安全。",
     "写成功不等于落盘：数据先进页缓存，调用 F sync 才算真正安全。"),
    (2, 30.1, "块、文件、对象，三种接口，对应三种截然不同的场景。", None),
    (3, 3.2, "IOPS、吞吐与延迟，是衡量存储的三把尺子；而决定体验的，往往是尾延迟。",
     "I O P S、吞吐与延迟，是衡量存储的三把尺子；而决定体验的，往往是尾延迟。"),
    (3, 11.6, "USE 方法按图索骥：对每个资源，检查使用率、饱和度与错误。",
     "U S E 方法按图索骥：对每个资源，检查使用率、饱和度与错误。"),
    (3, 18.4, "用 BPF 深入内核，把每一次 I/O 的延迟画成直方图。",
     "用 B P F 深入内核，把每一次 I O 的延迟画成直方图。"),
    (3, 24.6, "用 fio 建立基线再调优——没有基线的调优，都是玄学。",
     "用 F I O 建立基线再调优——没有基线的调优，都是玄学。"),
    (4, 3.2, "存储走上网络：NFS、iSCSI 与 NVMe-oF，让远端的盘像本地一样好用。",
     "存储走上网络：N F S、I SCSI 与 N V M E over Fabrics，让远端的盘像本地一样好用。"),
    (4, 12.0, "分布式存储用哈希与 CRUSH 算法，把海量数据均匀撒向每个节点。",
     "分布式存储用哈希与 Crush 算法，把海量数据均匀撒向每个节点。"),
    (4, 18.6, "三副本简单可靠，纠删码更省空间，容量与重建代价需要权衡。", None),
    (4, 25.5, "Ceph 把这一切组合起来：MON 维护集群地图，OSD 存放数据。",
     "Ceph 把这一切组合起来：Mon 维护集群地图，O S D 存放数据。"),
    (5, 3.2, "用 cephadm 引导集群：几条命令，就把 MON、MGR 与 OSD 铺满每台主机。",
     "用 Ceph adm 引导集群：几条命令，就把 Mon、M G R 与 O S D 铺满每台主机。"),
    (5, 11.4, "同一套集群，同时提供 RBD 块存储、CephFS 文件系统和 S3 对象网关。",
     "同一套集群，同时提供 R B D 块存储、Ceph F S 文件系统和 S 3 对象网关。"),
    (5, 19.3, "借助 CSI 与 Rook，Kubernetes 里的每个 PVC，都自动变成一块 Ceph 卷。",
     "借助 C S I 与 Rook，Kubernetes 里的每个 P V C，都自动变成一块 Ceph 卷。"),
    (5, 26.9, "凌晨三点，一块盘坏了：告警响起，PG 降级，集群自动恢复数据。",
     "凌晨三点，一块盘坏了：告警响起，P G 降级，集群自动恢复数据。"),
    (5, 34.3, "监控与巡检，让小问题在变成大事故之前就被发现。", None),
    (6, 3.2, "RDMA 绕过内核、直达网卡，把网络延迟压到微秒级。",
     "R D M A 绕过内核、直达网卡，把网络延迟压到微秒级。"),
    (6, 9.4, "GPFS 多集群模型：存储集群提供文件系统，计算集群远程挂载。",
     "G P F S 多集群模型：存储集群提供文件系统，计算集群远程挂载。"),
    (6, 16.8, "AI 训练对存储近乎苛刻：数据集高并发读取，checkpoint 瞬间写满带宽。",
     "A I 训练对存储近乎苛刻：数据集高并发读取，check point 瞬间写满带宽。"),
    (6, 24.6, "再学会容量规划与 on-call，为 GPU 集群扛起存储的重任。",
     "再学会容量规划与 on call，为 G P U 集群扛起存储的重任。"),
    (7, 6.8, "六个阶段，三十八节课，约二十七小时。", None),
    (7, 11.3, "只需一台电脑和一台 Linux 虚拟机，现在就启程。", None),
]


def budget(i):
    s, a = L[i][0], L[i][1]
    if i + 1 < len(L) and L[i + 1][0] == s:
        return L[i + 1][1] - a - 0.12
    return DUR[s] - a + 0.2


def duration(f):
    o = subprocess.run(['afinfo', f], capture_output=True, text=True).stdout
    return float(re.search(r'estimated duration: ([\d.]+)', o).group(1))


def tts(text, rate, f):
    for _ in range(4):  # 网络偶发失败时重试
        r = subprocess.run(['uvx', 'edge-tts', '--voice', VOICE, f'--rate=+{rate}%', '--text', text,
                            '--write-media', f], capture_output=True)
        if r.returncode == 0:
            return
    raise SystemExit(r.stderr.decode())


def main():
    dry = '--dry' in sys.argv
    out, over = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (s, a, cap, spoken) in enumerate(L):
            f, win, rate = f'{tmp}/l{i:02d}.mp3', budget(i), BASE_RATE
            while True:
                tts(spoken or cap, rate, f)
                d = duration(f)
                if d <= win or rate >= MAX_RATE:
                    break
                rate = min(MAX_RATE, rate + max(4, int((d / win - 1) * 100) + 3))
            over += d > win
            print(f'{i:02d} 场景{s} {a:5.1f}s 可用 {win:4.1f}s 实际 {d:4.2f}s 语速 +{rate}%' + ('' if d <= win else '  <-- OVER'))
            out.append(dict(s=s, a=a, d=round(d, 2), text=cap, b64=base64.b64encode(open(f, 'rb').read()).decode()))
    if dry:
        return
    html = PLAYER.read_text()
    data = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    html, n = re.subn(r'const VO_DATA=\[.*?\];\n', lambda m: f'const VO_DATA={data};\n', html, count=1, flags=re.S)
    assert n == 1, '未在 player.html 中找到 VO_DATA'
    PLAYER.write_text(html)
    print(f'已写入 {PLAYER.relative_to(ROOT)}' + (f'，{over} 句超时，请缩短文案' if over else ''))


if __name__ == '__main__':
    main()
