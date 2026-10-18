import { useParams } from "react-router";
import { RecordingDetail } from "@/components/recording/recording-detail";

/** /recordings/:id. The full recording view. */
export default function Page() {
    const { id } = useParams();
    if (!id) return null;
    return <RecordingDetail id={id} variant="page" />;
}
