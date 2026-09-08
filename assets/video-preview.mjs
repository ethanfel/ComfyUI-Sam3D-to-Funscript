// Pixel mapping reverses render(): stabilized = original + padding - shift.
export function previewShift(mapping, timeMs) {
    const ts=mapping.times_ms;
    let lo=0,hi=ts.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ts[mid]<=timeMs+.001)lo=mid;else hi=mid-1;}
    return mapping.shift_xy[lo];
}
export function originalPixel(mapping, point, timeMs) {
    const shift=previewShift(mapping,timeMs);
    return point.map((v,i)=>v-mapping.padding_xy[i]+shift[i]);
}
export function previewMediaTime(timeMs, variant, mapping, sourceOriginMs = 0) {
    const offset=mapping?(variant==="original"?mapping.source_offset_ms:0):sourceOriginMs;
    return (timeMs+offset)/1000;
}
export function previewTimelineTime(seconds, variant, mapping, sourceOriginMs = 0) {
    const offset=mapping?(variant==="original"?mapping.source_offset_ms:0):sourceOriginMs;
    return seconds*1000-offset;
}
