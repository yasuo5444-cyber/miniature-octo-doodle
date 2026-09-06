export const MAP_ORDER = ['sunset', 'harbor', 'mountain', 'canyon', 'random', 'construction'];

export const MAPS = {
    sunset: {
        name: '선셋 서킷', icon: '🌇', diff: 1, cp: 12, scale: 1.0,
        desc: '평지 · 완만한 코너 · 입문용 (약 980m)',
        pts: [[0, -140, 0], [90, -130, 0], [150, -70, 0], [140, 10, 0], [90, 60, 0], [100, 130, 0], [30, 160, 0], [-60, 140, 0], [-120, 80, 0], [-150, 0, 0], [-120, -80, 0], [-70, -130, 0]],
        pads: [0.3, 0.62, 0.85], jumps: [],
        palette: { sky: 0xffb27a, fog: 0xf7c9a0, ground: 0x6f9e4a, road: 0x4a4a52, curbA: 0xd63a3a, curbB: 0xf2f2f2, wall: 0xe6e6ec, emb: 0x5d8a3c, light: 0xfff0d8 },
        decor: { tree: 140, building: 45 },
    },
    harbor: {
        name: '하버 GP', icon: '⚓', diff: 2, cp: 18, scale: 0.85,
        desc: '대형 · 긴 직선 + 시케인 · 고속 (약 1,650m)',
        pts: [[-300, -120, 0], [-100, -140, 0], [100, -140, 0], [280, -120, 5], [340, -40, 7], [300, 40, 3], [220, 60, 0], [160, 120, 0], [200, 200, 0], [120, 260, 0], [0, 240, 0], [-100, 270, 0], [-200, 230, 0], [-260, 150, 0], [-220, 80, 0], [-280, 20, 0], [-340, -50, 0]],
        pads: [0.12, 0.4, 0.58, 0.8], jumps: [],
        palette: { sky: 0x9fd3ff, fog: 0xcfe6f7, ground: 0x7fa56b, road: 0x50535a, curbA: 0x2f6fd6, curbB: 0xf2f2f2, wall: 0xd9dde3, emb: 0x6c8f5a, light: 0xffffff },
        decor: { container: 90, building: 30, crane: 6 },
    },
    mountain: {
        name: '마운틴 패스', icon: '⛰️', diff: 3, cp: 16, scale: 0.68,
        desc: '오르막·내리막 36m · 헤어핀 · 점프 1개 (약 1,750m)',
        pts: [[-200, -200, 0], [0, -200, 0], [160, -190, 2], [240, -130, 8], [250, -50, 14], [180, 0, 18], [40, 10, 22], [-80, 0, 26], [-180, 20, 28], [-160, 110, 30], [-20, 120, 32], [120, 110, 34], [220, 130, 36], [260, 200, 34], [200, 260, 30], [80, 270, 24], [-60, 260, 18], [-180, 250, 14], [-260, 190, 10], [-280, 80, 8], [-270, -60, 5], [-250, -150, 2]],
        pads: [0.08, 0.35, 0.6, 0.88], jumps: [{ pt: 15, len: 50, h: 3.5 }],
        palette: { sky: 0xa9c9e8, fog: 0xc9dcec, ground: 0x5b8a45, road: 0x474a50, curbA: 0xd63a3a, curbB: 0xf2f2f2, wall: 0xcfd4d8, emb: 0x7a6a4c, light: 0xfff6e6 },
        decor: { pine: 260, rock: 70 },
    },
    canyon: {
        name: '캐니언 스파이럴', icon: '🏜️', diff: 4, cp: 20, scale: 0.8,
        desc: '대형 · 급경사 30m · 내리막 직후 급코너 · 점프 2개 (약 1,850m)',
        pts: [[-300, -250, 0], [-310, -100, 6], [-290, 60, 14], [-220, 170, 22], [-100, 200, 30], [20, 150, 22], [120, 190, 16], [240, 150, 10], [150, 60, 4], [60, 20, 2], [-40, 60, 8], [-80, -20, 14], [20, -40, 18], [160, -30, 10], [290, 5, 4], [330, -70, 0], [270, -140, 4], [170, -165, 12], [80, -125, 20], [0, -145, 26], [-60, -205, 22], [-150, -260, 12], [-240, -290, 4]],
        pads: [0.15, 0.33, 0.5, 0.7, 0.9], jumps: [{ pt: 12, len: 50, h: 3.5 }, { pt: 19, len: 55, h: 4 }],
        palette: { sky: 0xffcf9c, fog: 0xf3c99e, ground: 0xc98a55, road: 0x4d4a4a, curbA: 0xd66a2a, curbB: 0xf7e9d2, wall: 0xe0c9a8, emb: 0xa86f3f, light: 0xffe9c8 },
        decor: { mesa: 40, rock: 120, cactus: 60 },
    },
    random: {
        name: '랜덤 트랙', icon: '🎲', diff: 0, cp: 12, scale: 1.0,
        desc: '시드 기반 무작위 서킷 · 완만한 언덕 · 매번 다른 코스',
        pts: [],
        pads: [], jumps: [],
        palette: { sky: 0xffb27a, fog: 0xf7c9a0, ground: 0x6f9e4a, road: 0x4a4a52, curbA: 0xd63a3a, curbB: 0xf2f2f2, wall: 0xe6e6ec, emb: 0x5d8a3c, light: 0xfff0d8 },
        decor: { tree: 120, building: 35 },
    },
    construction: {
        name: '익스트림 공사장', icon: '🚧', diff: 5, cp: 18, scale: 0.85,
        desc: '하드코어 · 8자 입체 교차로와 지하 터널 (약 1,600m)',
        // 완벽한 8자 모양 입체교차로 좌표입니다.
        pts: [
            [100, 150, 0], [0, 0, 4], [-100, -150, 8], [-200, -150, 12],
            [-200, 150, 16], [-100, 150, 20], [0, 0, 24], [100, -150, 28],
            [200, -150, 20], [200, 150, 10]
        ],
        pads: [0.15, 0.4, 0.6, 0.85],
        jumps: [{ pt: 7, len: 50, h: 4 }], // 가장 높은 28m 고지대에서 점프!
        bridges: [{ pt: 6, len: 250 }],    // 위쪽 도로는 흙이 뚫고 나오지 않게 고가도로 처리
        tunnels: [{ pt: 1, len: 250 }],    // 아래쪽으로 지나가는 도로는 어두운 돔 형태의 터널로 처리
        palette: {
            sky: 0xd98f5e, fog: 0xc48052, ground: 0x5a4a3c, road: 0x3b3f45,
            curbA: 0xffd23f, curbB: 0x111111, // 공사장 테마: 노랑/검정 경고 무늬 연석!
            wall: 0x8c8c8c, emb: 0x665544, light: 0xffe6cc
        },
        decor: { crane: 12, container: 60, building: 15, rock: 30 },
    }
};
