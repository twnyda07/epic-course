/**
 * 部署設定。
 * API 留空時，網站會進入「離線預覽模式」：直接讀 seed.json，
 * 只能看、不能存，方便在後端還沒部署好之前先檢查畫面。
 *
 * 這裡只有 Web App 網址，沒有密碼——光有網址不帶密碼，後端什麼都不會給。
 */
window.CFG = {
  API: 'https://script.google.com/macros/s/AKfycbx-HGRS1W3jei4l-PMhv-W5Rcpx1FSeYN7uIH60evG5ImaZ9_4sgOPODgAEpyCX-ABr/exec',
  標題: 'EPIC 禪藝實相人文空間　排課系統'
};
